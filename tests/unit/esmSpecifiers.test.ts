// Tests for the unconditional ESM-specifier rewrite: adding `.js` to relative
// specifiers in emitted ESM (JS and declarations), and where it sits in
// `linked build`.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {buildPackage, planBuildSteps} from '../../src/cli-methods.js';
import {isImportOutsideOfPackage} from '../../src/utils.js';
import {rewriteExtensionlessImports} from '../../src/utils/esmSpecifiers.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-esm-'));
});

afterEach(() => {
  fs.removeSync(dir);
  jest.restoreAllMocks();
});

const write = (file: string, content = 'export {};\n') => {
  fs.outputFileSync(path.join(dir, file), content);
};
const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');

describe('rewriteExtensionlessImports', () => {
  test('rewrites file import', async () => {
    write('shapes/Example.js');
    write('index.js', "import {A} from './shapes/Example';\n");
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('index.js')).toBe("import {A} from './shapes/Example.js';\n");
  });

  test('rewrites directory import', async () => {
    write('shapes/index.js');
    write('index.js', "export * from './shapes';\n");
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('index.js')).toBe("export * from './shapes/index.js';\n");
  });

  test('rewrites dynamic import', async () => {
    write('x.js');
    write('index.js', "const m = import('./x');\n");
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('index.js')).toBe("const m = import('./x.js');\n");
  });

  test('rewrites side-effect import and parent-relative specifiers', async () => {
    write('package.js');
    write('shapes/Example.js', 'import "../package";\n');
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('shapes/Example.js')).toBe('import "../package.js";\n');
  });

  test('leaves extensioned, bare and json specifiers', async () => {
    write('a.js');
    write('d.json', '{}');
    const source =
      "import './a.js';\nimport {Shape} from '@_linked/core';\nimport d from './d.json';\n";
    write('index.js', source);
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(0);
    expect(read('index.js')).toBe(source);
  });

  test('leaves unresolvable and reports them', async () => {
    write('b.js');
    write('index.js', "import './missing';\nimport './b';\n");
    write('other.js', "import './missing';\n");
    const result = await rewriteExtensionlessImports(dir);
    expect(result.changed).toBe(1);
    expect(read('index.js')).toBe("import './missing';\nimport './b.js';\n");
    expect(read('other.js')).toBe("import './missing';\n");
    expect(result.unresolved).toEqual([
      "'./missing' in index.js",
      "'./missing' in other.js",
    ]);
  });

  test("'.' and '..' resolve to index.js", async () => {
    write('index.js');
    write('sub/index.js', "export * from '.';\nimport '..';\n");
    const result = await rewriteExtensionlessImports(dir);
    expect(result.unresolved).toEqual([]);
    expect(read('sub/index.js')).toBe(
      "export * from './index.js';\nimport '../index.js';\n",
    );
  });

  test("'./dir/' strips the trailing slash and never yields './dir/.js'", async () => {
    write('dir/index.js');
    write('index.js', "import './dir/';\n");
    await rewriteExtensionlessImports(dir);
    expect(read('index.js')).toBe("import './dir/index.js';\n");
  });

  test('a trailing slash names a directory, so a sibling file is not a match', async () => {
    // './file/' explicitly asks for a directory. Resolving it to './file.js'
    // would silently load something the author did not ask for.
    write('file.js');
    write('index.js', "import './file/';\n");
    const result = await rewriteExtensionlessImports(dir);
    expect(read('index.js')).toBe("import './file/';\n");
    expect(result.unresolved).toEqual(["'./file/' in index.js"]);
  });

  test('a trailing slash still resolves the directory index over a sibling file', async () => {
    write('both.js');
    write('both/index.js');
    write('index.js', "import './both/';\n");
    const result = await rewriteExtensionlessImports(dir);
    expect(read('index.js')).toBe("import './both/index.js';\n");
    expect(result.unresolved).toEqual([]);
  });

  test('a file wins over a directory of the same name when no slash is given', async () => {
    write('both.js');
    write('both/index.js');
    write('index.js', "import './both';\n");
    await rewriteExtensionlessImports(dir);
    expect(read('index.js')).toBe("import './both.js';\n");
  });

  test('rewrites import x = require()', async () => {
    write('y.js');
    write('index.d.ts', "import y = require('./y');\n");
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('index.d.ts')).toBe("import y = require('./y.js');\n");
  });

  test('a template literal with substitutions is skipped without a warning', async () => {
    write('x.js');
    const source = 'const m = (n) => import(`./${n}`);\n';
    write('index.js', source);
    expect(await rewriteExtensionlessImports(dir)).toEqual({
      changed: 0,
      unresolved: [],
    });
    expect(read('index.js')).toBe(source);
  });

  test('rewrites export * as namespace', async () => {
    write('x.js');
    write('index.js', "export * as ns from './x';\n");
    await rewriteExtensionlessImports(dir);
    expect(read('index.js')).toBe("export * as ns from './x.js';\n");
  });

  test('leaves strings and comments that look like imports', async () => {
    write('x.js');
    const source =
      "// import {a} from './x';\n/* export * from './x'; */\nconst s = \"import './x'\";\nconst t = `from './x'`;\n";
    write('index.js', source);
    const result = await rewriteExtensionlessImports(dir);
    expect(result).toEqual({changed: 0, unresolved: []});
    expect(read('index.js')).toBe(source);
  });

  test('rewrites .d.ts alongside .js', async () => {
    write('shapes/Example.js');
    write('shapes/Example.d.ts');
    write('index.js', "export * from './shapes/Example';\n");
    write('index.d.ts', "export * from './shapes/Example';\n");
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(2);
    expect(read('index.d.ts')).toBe("export * from './shapes/Example.js';\n");
    expect(read('index.js')).toBe("export * from './shapes/Example.js';\n");
  });

  test('rewrites import/export/import() type positions in a .d.ts', async () => {
    write('a.js');
    write('a.d.ts');
    write('b/index.js');
    write('b/index.d.ts');
    write(
      'index.d.ts',
      [
        "import type {A} from './a';",
        "export {B} from './b';",
        "export declare const c: import('./a').A;",
        "export declare const d: typeof import('./b');",
        '',
      ].join('\n'),
    );
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('index.d.ts')).toBe(
      [
        "import type {A} from './a.js';",
        "export {B} from './b/index.js';",
        "export declare const c: import('./a.js').A;",
        "export declare const d: typeof import('./b/index.js');",
        '',
      ].join('\n'),
    );
  });

  test('rewrites imports inside a declare module body', async () => {
    write('a.js');
    write('a.d.ts');
    write(
      'index.d.ts',
      "declare module 'ext' {\n  import {A} from './a';\n  export {A};\n}\n",
    );
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(1);
    expect(read('index.d.ts')).toContain("from './a.js'");
  });

  test('a declaration may target a types-only module, JS may not', async () => {
    write('types.d.ts');
    write('index.d.ts', "export type {T} from './types';\n");
    write('index.js', "export * from './types';\n");
    const result = await rewriteExtensionlessImports(dir);
    expect(read('index.d.ts')).toBe("export type {T} from './types.js';\n");
    expect(read('index.js')).toBe("export * from './types';\n");
    expect(result.unresolved).toEqual(["'./types' in index.js"]);
  });

  test('a package that already writes .js specifiers is untouched', async () => {
    write('shapes/Example.js');
    write('shapes/Example.d.ts');
    const js = "export * from './shapes/Example.js';\n";
    const dts = "export * from './shapes/Example.js';\n";
    write('index.js', js);
    write('index.d.ts', dts);
    expect(await rewriteExtensionlessImports(dir)).toEqual({
      changed: 0,
      unresolved: [],
    });
    expect(read('index.js')).toBe(js);
    expect(read('index.d.ts')).toBe(dts);
  });

  test('idempotent', async () => {
    write('shapes/index.js', "export * from './Example';\n");
    write('shapes/Example.js');
    write('index.js', "export * from './shapes';\n");
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(2);
    expect((await rewriteExtensionlessImports(dir)).changed).toBe(0);
  });
});

describe('planBuildSteps', () => {
  const names = (pkgJson: any = {}) =>
    planBuildSteps(pkgJson, dir).map((step) => step.name);

  const withEsmConfig = () =>
    fs.outputFileSync(path.join(dir, 'tsconfig-esm.json'), '{}');

  test('every package checks imports and then rewrites the ESM output', () => {
    expect(names()).toEqual([
      'Checking imports',
      'Compiling ESM',
      'Compiling CJS',
      'Copying files to lib folder',
      'Dual package support',
      'Removing old files from lib folder',
      'Rewriting ESM import specifiers',
      'Checking shape names',
      'Checking shape references',
      'Checking shapes/index',
      'Checking sideEffects',
      'Checking dependencies',
    ]);
  });

  test('the rewrite runs after the copy and the cleanup steps', () => {
    const order = names();
    expect(order.indexOf('Rewriting ESM import specifiers')).toBeGreaterThan(
      order.indexOf('Copying files to lib folder'),
    );
    expect(order.indexOf('Rewriting ESM import specifiers')).toBeGreaterThan(
      order.indexOf('Removing old files from lib folder'),
    );
  });

  const rewriteStep = () =>
    planBuildSteps({}, dir).find(
      (step) => step.name === 'Rewriting ESM import specifiers',
    )!;

  test('the rewrite step fails when lib/esm is missing', async () => {
    withEsmConfig();
    const result: any = await rewriteStep().apply();
    expect(result.error).toMatch(/lib\/esm was not emitted/);
  });

  test('a package with no ESM build skips the rewrite instead of failing', async () => {
    // No tsconfig-esm.json, so the ESM compile was skipped too.
    expect(fs.existsSync(path.join(dir, 'tsconfig-esm.json'))).toBe(false);
    expect(await rewriteStep().apply()).toBe(true);
  });

  test('the rewrite step warns with the unresolved specifiers', async () => {
    withEsmConfig();
    fs.outputFileSync(
      path.join(dir, 'lib/esm/index.js'),
      "import './missing';\n",
    );
    const result = await rewriteStep().apply();
    expect(typeof result).toBe('string');
    expect(result).toContain("'./missing' in index.js");
  });

  test('the rewrite step succeeds when everything resolves', async () => {
    withEsmConfig();
    fs.outputFileSync(path.join(dir, 'lib/esm/x.js'), 'export {};\n');
    fs.outputFileSync(path.join(dir, 'lib/esm/index.js'), "import './x';\n");
    expect(await rewriteStep().apply()).toEqual({info: 'rewrote 1 file(s)'});
  });

  test('the rewrite step is silent when there was nothing to rewrite', async () => {
    withEsmConfig();
    fs.outputFileSync(path.join(dir, 'lib/esm/index.js'), "import './x.js';\n");
    fs.outputFileSync(path.join(dir, 'lib/esm/x.js'), 'export {};\n');
    expect(await rewriteStep().apply()).toBe(true);
  });

  // The ordering fixes: what the rewrite sees depends on the copy and the
  // cleanup steps having already run.
  const runStepsFrom = async (first: string) => {
    const steps = planBuildSteps({}, dir);
    const from = steps.findIndex((step) => step.name === first);
    const results: Record<string, unknown> = {};
    for (const step of steps.slice(
      from,
      steps.findIndex((s) => s.name === 'Rewriting ESM import specifiers') + 1,
    )) {
      results[step.name] = await step.apply();
    }
    return results;
  };

  test('an asset import resolves because the copy step ran first', async () => {
    withEsmConfig();
    // `defaults/component.tsx` generates `import './x.scss'`; tsc emits it
    // verbatim into lib/esm, and the copy step brings the .scss along.
    fs.outputFileSync(path.join(dir, 'src/x.scss'), '.a {color: red;}\n');
    fs.outputFileSync(
      path.join(dir, 'lib/esm/index.js'),
      "import './x.scss';\n",
    );
    const results = await runStepsFrom('Copying files to lib folder');
    // No warning string: the build is clean.
    expect(results['Rewriting ESM import specifiers']).toBe(true);
    // A non-JS asset is left exactly as written.
    expect(fs.readFileSync(path.join(dir, 'lib/esm/index.js'), 'utf8')).toBe(
      "import './x.scss';\n",
    );
  });

  test('a hand-written src .d.ts is rewritten because the copy step ran first', async () => {
    withEsmConfig();
    fs.outputFileSync(
      path.join(dir, 'src/types.d.ts'),
      "export * from './a';\n",
    );
    fs.outputFileSync(path.join(dir, 'lib/esm/a.js'), 'export {};\n');
    await runStepsFrom('Copying files to lib folder');
    expect(fs.readFileSync(path.join(dir, 'lib/esm/types.d.ts'), 'utf8')).toBe(
      "export * from './a.js';\n",
    );
  });

  test('a stale lib/esm file is removed before it can capture a specifier', async () => {
    withEsmConfig();
    // 'stale.js' is left over from an earlier build: old enough for the
    // cleanup step, which only deletes files untouched for over 120 seconds.
    const stale = path.join(dir, 'lib/esm/x.js');
    fs.outputFileSync(stale, 'export {};\n');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    fs.outputFileSync(path.join(dir, 'lib/esm/index.js'), "import './x';\n");

    const results = await runStepsFrom('Removing old files from lib folder');

    expect(fs.existsSync(stale)).toBe(false);
    // The specifier is reported rather than pointed at a deleted file.
    expect(results['Rewriting ESM import specifiers']).toContain(
      "'./x' in index.js",
    );
    expect(fs.readFileSync(path.join(dir, 'lib/esm/index.js'), 'utf8')).toBe(
      "import './x';\n",
    );
  });
});

describe('a build step that returns false', () => {
  test('fails the build with a message naming the step', async () => {
    fs.outputJsonSync(path.join(dir, 'package.json'), {
      name: 'pkg',
      linkedPackage: true,
    });
    // No tsconfig-*.json, so both compile steps are skipped. 'lib/esm' is a
    // FILE, so copying 'src/a.json' into it throws and the copy step — like
    // several others — returns a literal false rather than {error}.
    fs.outputFileSync(path.join(dir, 'src/a.json'), '{}\n');
    fs.outputFileSync(path.join(dir, 'lib/esm'), 'not a directory\n');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errors: string[] = [];
    jest
      .spyOn(console, 'error')
      .mockImplementation((...args) => errors.push(args.join(' ')));

    // logResults: false, so the failure is written to console.error.
    const result = await buildPackage(null, null, dir, false);

    expect(result).toBe(false);
    expect(errors.join('\n')).toContain('Copying files to lib folder failed');
  });
});

describe('checkImports', () => {
  const src = () => path.join(dir, 'src');
  const writeSrc = (file: string, content: string) =>
    fs.outputFileSync(path.join(src(), file), content);

  const check = () =>
    planBuildSteps({}, dir)
      .find((step) => step.name === 'Checking imports')!
      .apply();

  test('extensionless relative imports are allowed', async () => {
    writeSrc('index.ts', "import {Example} from './shapes/Example';\n");
    writeSrc('shapes/Example.ts', 'export class Example {}\n');
    await expect(check()).resolves.toBe(true);
  });

  test('importing from outside the package fails the build', async () => {
    writeSrc('index.ts', "import {Thing} from '../../elsewhere/Thing.js';\n");
    await expect(check()).rejects.toContain('outside the package source root');
  });

  test.each([
    ['@_linked/core/lib/esm/utils/Shape.js'],
    ['@_linked/core/src/utils/Shape.js'],
    ['lincd-foo/src/shapes/Thing.js'],
    ['lincd-foo/lib/esm/shapes/Thing.js'],
  ])(
    "reaching into another Linked package's internals fails the build: %s",
    async (specifier) => {
      writeSrc('index.ts', `import {Thing} from '${specifier}';\n`);
      await expect(check()).rejects.toContain('/src/ or /lib/');
    },
  );

  // Every form that names a module is checked, not only `import ... from`.
  test.each([
    ["export * from '@_linked/core/lib/esm/x';"],
    ["export {A} from '@_linked/core/lib/esm/x';"],
    ["const m = import('@_linked/core/lib/esm/x');"],
    ["type A = import('@_linked/core/lib/esm/x').A;"],
    ["import x = require('@_linked/core/lib/esm/x');"],
  ])('%s is flagged too', async (statement) => {
    writeSrc('index.ts', statement + '\n');
    await expect(check()).rejects.toContain('/src/ or /lib/');
  });

  test('a computed dynamic import is not checked and does not throw', async () => {
    writeSrc('index.ts', 'export const load = (n: string) => import(n);\n');
    await expect(check()).resolves.toBe(true);
  });

  test.each([
    // A public subpath of a Linked package.
    ['@_linked/core/utils/Shape.js'],
    // 'library' is not the 'lib' segment.
    ['@_linked/core/library/Shape.js'],
    // A local folder that merely happens to be called lib/ or src/.
    ['./lib/helpers.js'],
    ['./src/helpers.js'],
    // A non-Linked package that happens to expose a lib/ path.
    ['some-other-pkg/lib/thing.js'],
  ])('%s is allowed', async (specifier) => {
    writeSrc('index.ts', `import {Thing} from '${specifier}';\n`);
    fs.outputFileSync(
      path.join(src(), 'lib/helpers.ts'),
      'export const a = 1;\n',
    );
    fs.outputFileSync(
      path.join(src(), 'src/helpers.ts'),
      'export const a = 1;\n',
    );
    await expect(check()).resolves.toBe(true);
  });
});

describe('isImportOutsideOfPackage', () => {
  test.each([
    // Depth 0 (src/index.ts): a single '..' already leaves src/.
    ['../elsewhere/Thing.js', 0, true],
    ['..', 0, true],
    ['../..', 0, true],
    ['./a/../b', 0, false],
    // A file name that merely contains dots is not a climb.
    ['./a..b', 0, false],
    ['./a..b/c', 0, false],
    ['../a..b', 0, true],
    // Depth 1 (src/foo/index.ts): one level up is still inside src/.
    ['../sibling/Thing.js', 1, false],
    ['../../elsewhere/Thing.js', 1, true],
    // Normalisation cancels the climb back out again.
    ['../a/../b', 1, false],
    ['../a/../../b', 1, true],
    ['./a/../../b', 1, false],
    ['./a/../../../b', 1, true],
    // Bare specifiers never escape the package, whatever they contain.
    ['@_linked/core', 0, false],
    ['some-pkg/a..b', 0, false],
  ])('%s at depth %i -> %s', (importPath, depth, expected) => {
    expect(
      isImportOutsideOfPackage(importPath as string, depth as number),
    ).toBe(expected);
  });
});
