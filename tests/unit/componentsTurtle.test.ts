import fs from 'fs';
import os from 'os';
import path from 'path';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {planBuildSteps} from '../../src/cli-methods.js';
import {
  collectComponentsTurtleInputs,
  COMPONENTS_TURTLE_PATH,
  generateComponentsTurtle,
  writeComponentsTurtleStep,
} from '../../src/utils/componentsTurtle';
import {fixtureNodeModules} from '../fixtureNodeModules';

// Each fixture is a compiled package (lib/esm as tsc emits it) run in a real `node` child, as the
// build step runs it. The generator is a stub `@_linked/react/utils/componentIndex` in the
// fixture's node_modules: these tests cover the step's mechanics, react's own tests the Turtle.

let dir: string;
const write = (file: string, content: string) => {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  fs.writeFileSync(full, content);
};
const target = () => path.join(dir, COMPONENTS_TURTLE_PATH);

// The stub writes what it saw: the load order, the package name and the component export names
// (exports with a `query`), and warns for an export named `Unserializable`.
const STUB_GENERATOR = `
export function componentIndexTurtle(packageName, exports, warnings) {
  const names = Object.keys(exports).filter((k) => exports[k] && exports[k].query).sort();
  if (names.includes('Unserializable')) warnings.push('Unserializable: its query does not serialize (boom)');
  const kept = names.filter((n) => n !== 'Unserializable');
  if (!kept.length) return undefined;
  return ['# order ' + (globalThis.__fixtureOrder || []).join(','), '# package ' + packageName, ...kept.map((n) => '# component ' + n)].join('\\n') + '\\n';
}
`;

const stubReact = ({generator = true}: {generator?: boolean} = {}) => {
  write('node_modules/@_linked/react/package.json', JSON.stringify({name: '@_linked/react', version: '2.1.0', type: 'module'}));
  if (generator) write('node_modules/@_linked/react/lib/esm/utils/componentIndex.js', STUB_GENERATOR);
};

const order = (name: string) => `(globalThis.__fixtureOrder ??= []).push('${name}');\n`;

/** The package `@test/fixture` (registering as `fixture-runtime`), with a components/index. */
const fixture = ({
  components = `${order('components')}export const PersonCard = {query: {}, shape: {}};\nexport const helper = () => 1;\n`,
  pkgJson = {},
  shapesIndex = true,
}: {components?: string | null; pkgJson?: object; shapesIndex?: boolean} = {}) => {
  write(
    'package.json',
    JSON.stringify({
      name: '@test/fixture',
      version: '1.0.0',
      type: 'module',
      main: 'lib/esm/index.js',
      files: ['lib'],
      dependencies: {'@_linked/core': '*', '@_linked/react': '*'},
      ...pkgJson,
    }),
  );
  write(
    'lib/esm/package.js',
    `import { linkedPackage } from '@_linked/core/utils/Package';\n${order('package')}export const { linkedShape, packageName } = linkedPackage('fixture-runtime');\n`,
  );
  if (shapesIndex) write('lib/esm/shapes/index.js', order('shapes'));
  if (components !== null) write('lib/esm/components/index.js', components);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-components-turtle-'));
  fixtureNodeModules(dir);
  stubReact();
});
afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

describe('Writing components.ttl', () => {
  test('loads package.js, shapes/index.js, components/index.js in order and names the runtime package', async () => {
    fixture();
    expect(await writeComponentsTurtleStep(dir)).toEqual({info: 'lib/esm/data/components.ttl'});
    expect(fs.readFileSync(target(), 'utf8')).toBe(
      '# order package,shapes,components\n# package fixture-runtime\n# component PersonCard\n',
    );
  });

  test('without shapes/index, package.js and components/index.js are loaded', async () => {
    fixture({shapesIndex: false});
    const inputs = collectComponentsTurtleInputs(dir);
    expect('modules' in inputs && inputs.modules.map((m) => m.split('/lib/esm/')[1])).toEqual([
      'package.js',
      'components/index.js',
    ]);
  });

  test('no components/index: no file, and an earlier one is removed', async () => {
    fixture({components: null});
    write(COMPONENTS_TURTLE_PATH, 'stale\n');
    expect(collectComponentsTurtleInputs(dir)).toEqual({skip: true});
    expect(await writeComponentsTurtleStep(dir)).toBe(true);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('a components/index without linked components gives no file', async () => {
    fixture({components: 'export const helper = () => 1;\n'});
    write(COMPONENTS_TURTLE_PATH, 'stale\n');
    expect(await generateComponentsTurtle(dir)).toEqual({turtle: undefined, warnings: []});
    expect(await writeComponentsTurtleStep(dir)).toBe(true);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('a package without a @_linked/react dependency is skipped quietly', async () => {
    fixture({pkgJson: {dependencies: {'@_linked/core': '*'}}});
    expect(await writeComponentsTurtleStep(dir)).toBe(true);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('asset imports resolve, a missing .svg included', async () => {
    fixture({
      components: `import styles from './Card.module.css';\nimport icon from './icon.svg';\nexport const PersonCard = {query: {}, shape: {}, cls: styles.card, icon};\n`,
    });
    write('lib/esm/components/Card.module.css', '.card {}\n');
    expect(fs.existsSync(path.join(dir, 'lib/esm/components/icon.svg'))).toBe(false);
    expect(await writeComponentsTurtleStep(dir)).toEqual({info: 'lib/esm/data/components.ttl'});
  });

  test('a module that throws fails the step, names it and removes an earlier file', async () => {
    fixture({components: "import './Broken.js';\nexport const PersonCard = {query: {}, shape: {}};\n"});
    write('lib/esm/components/Broken.js', "throw new Error('boom');\n");
    write(COMPONENTS_TURTLE_PATH, 'stale\n');
    const result = (await writeComponentsTurtleStep(dir)) as {error: string};
    expect(result.error).toMatch(/^loading file:.*components\/index\.js: Error: boom/);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('a react without utils/componentIndex warns and writes nothing', async () => {
    fixture();
    fs.rmSync(path.join(dir, 'node_modules', '@_linked', 'react'), {recursive: true});
    stubReact({generator: false});
    write(COMPONENTS_TURTLE_PATH, 'stale\n');
    expect(await writeComponentsTurtleStep(dir)).toBe(
      'skipped: the @_linked/react this package resolves (2.1.0) has no utils/componentIndex',
    );
    expect(fs.existsSync(target())).toBe(false);
  });

  test("the generator's warnings are the step's warning", async () => {
    fixture({
      components: 'export const PersonCard = {query: {}, shape: {}};\nexport const Unserializable = {query: {}, shape: {}};\n',
    });
    expect(await writeComponentsTurtleStep(dir)).toBe(
      'lib/esm/data/components.ttl written; Unserializable: its query does not serialize (boom)',
    );
    expect(fs.readFileSync(target(), 'utf8')).toContain('# component PersonCard');
  });

  test('--skip-shape-check skips the step, removes an earlier file and says so', async () => {
    fixture();
    write(COMPONENTS_TURTLE_PATH, 'stale\n');
    const message = 'skipped with --skip-shape-check (pending the data fix): no components.ttl written';
    expect(await writeComponentsTurtleStep(dir, {skip: 'pending the data fix'})).toBe(message);
    expect(fs.existsSync(target())).toBe(false);
    write(COMPONENTS_TURTLE_PATH, 'stale\n');
    const step = planBuildSteps({}, dir, {skipShapeCheck: 'pending the data fix'}).find(
      (s) => s.name === 'Writing components.ttl',
    )!;
    expect(await step.apply()).toBe(message);
    expect(fs.existsSync(target())).toBe(false);
  });

  test('the build writes components.ttl right after shapes.ttl', () => {
    const names = planBuildSteps({}, dir).map((s) => s.name);
    expect(names.indexOf('Writing components.ttl')).toBe(names.indexOf('Writing shapes.ttl') + 1);
  });
});
