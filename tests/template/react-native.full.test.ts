// Full test for `create-app --template react-native`, including its backend.
//
// Scaffolds with the BUILT CLI, with install, into a temp directory, then proves
// the generated monorepo: its files and stamped names, one React, lint,
// typecheck, its own tests, the shapes build and a Metro iOS bundle.
// Needs network and takes several minutes. Gated by RUN_TEMPLATE_FULL=1 (set by
// `npm run test:template`) so it never runs by accident.
//
// The scaffold's `node_modules/@_linked/cli/lib` (and `hooks`) is replaced with this repo's
// `lib` (and `hooks`), so the scaffold's `linked build` is the CLI under test, not the pinned
// release.
import {execFileSync, execSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(CLI_ROOT, 'lib', 'esm', 'launch.js');
const TEMPLATE = path.join(CLI_ROOT, 'defaults', 'app-react-native');
const TEN_MINUTES = 10 * 60 * 1000;
const PREFIX = 'demo';

const describeFull =
  process.env.RUN_TEMPLATE_FULL === '1' ? describe : describe.skip;

const run = (command: string, cwd: string) => {
  try {
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024,
      env: {...process.env, CI: '1', FORCE_COLOR: '0'},
    });
  } catch (err: any) {
    throw new Error(
      `\`${command}\` failed (exit ${err.status}):\n${err.stdout}\n${err.stderr}`,
    );
  }
};

const read = (app: string, file: string) =>
  fs.readFileSync(path.join(app, file), 'utf8');

const overlayLib = (app: string, pkg: string, lib: string) => {
  const target = path.join(app, 'node_modules', pkg, 'lib');
  fs.rmSync(target, {recursive: true, force: true});
  fs.cpSync(lib, target, {recursive: true});
};

describeFull('create-app --template react-native (full)', () => {
  let tmp: string;
  let app: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}; run the build first.`);
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-rn-full-'));
    app = path.join(tmp, PREFIX);
    execFileSync(
      process.execPath,
      [
        CLI,
        'create-app',
        PREFIX,
        '--template',
        'react-native',
        '--app-name',
        'Demo',
        '--app-prefix',
        PREFIX,
        '--app-domain',
        'example.com',
      ],
      {cwd: tmp, stdio: 'pipe', maxBuffer: 100 * 1024 * 1024},
    );
    overlayLib(app, '@_linked/cli', path.join(CLI_ROOT, 'lib'));
    // lib loads the hooks/ beside it (drift, localize), which the pinned release may not have.
    const hooks = path.join(app, 'node_modules', '@_linked', 'cli', 'hooks');
    fs.rmSync(hooks, {recursive: true, force: true});
    fs.cpSync(path.join(CLI_ROOT, 'hooks'), hooks, {recursive: true});
    fs.chmodSync(
      path.join(app, 'node_modules/@_linked/cli/lib/esm/launch.js'),
      0o755,
    );
  }, TEN_MINUTES);

  afterAll(() => {
    if (tmp && process.env.KEEP_TEMPLATE_FULL !== '1') {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  });

  test('installs', () => {
    expect(fs.existsSync(path.join(app, 'node_modules'))).toBe(true);
    expect(fs.existsSync(path.join(app, 'package-lock.json'))).toBe(true);
    expect(fs.existsSync(path.join(app, 'yarn.lock'))).toBe(false);
  });

  test('ships the backend files and renamed dotfiles', () => {
    for (const file of [
      '.gitignore',
      'docker-compose.yml',
      'eslint.config.js',
      'scripts/check-react.mjs',
      'apps/mobile/.gitignore',
      'apps/mobile/app.config.ts',
      'apps/mobile/src/shell/env.ts',
      'apps/mobile/src/shell/storage.ts',
      'apps/mobile/src/shell/apiPort.json',
      'apps/mobile/__tests__/storage.test.ts',
      'apps/mobile/src/components/PersonOverview.tsx',
      'apps/mobile/src/components/PersonPreview.tsx',
      'apps/mobile/src/components/PersonOverviewContext.tsx',
      'apps/mobile/jest.integration.config.js',
      'apps/mobile/__tests__/integration/personOverview.test.tsx',
      `packages/${PREFIX}-shapes/tsconfig-esm.json`,
      'services/api/.env.example',
      'services/api/linked.backend.storage.ts',
      'services/api/linked.backend.datasets.json',
      'services/api/scripts/wait-for-fuseki.mjs',
      'services/api/test/waitForFuseki.test.mjs',
      'services/api/src/backend.ts',
    ]) {
      expect([file, fs.existsSync(path.join(app, file))]).toEqual([file, true]);
    }
    expect(fs.existsSync(path.join(app, '.github'))).toBe(false);
    expect(
      fs.existsSync(path.join(app, 'services/api/env.example.template')),
    ).toBe(false);
    expect(read(app, '.gitignore')).toContain('services/api/data/');
    expect(read(app, 'apps/mobile/src/shell/storage.ts')).toContain(
      "import './env';",
    );
  });

  test('the shapes package builds with extensionless imports, without an opt-in', () => {
    const shapes = JSON.parse(
      read(app, `packages/${PREFIX}-shapes/package.json`),
    );
    expect(shapes.linkedPackage).toBe(true);
    expect(shapes.linked).toBeUndefined();
  });

  test('dataset names come from the prefix', () => {
    expect(read(app, 'services/api/.env.example')).toContain(
      `FUSEKI_DATASET=${PREFIX}-dev`,
    );
    expect(read(app, 'services/api/linked.backend.datasets.json')).toContain(
      `\${FUSEKI_DATASET:-${PREFIX}-dev}`,
    );
    expect(read(app, 'apps/mobile/__tests__/integration/apiEnv.ts')).toContain(
      `'${PREFIX}-test'`,
    );
  });

  test('check:react finds one React for the app', () => {
    // `npm ls react` lists React copies nested under @_linked/server(-utils) that
    // the app never loads, so the template checks resolution instead.
    expect(run('npm run check:react', app)).toMatch(/check:react OK/);
  });

  test(
    'npm run lint passes',
    () => {
      run('npm run lint', app);
    },
    TEN_MINUTES,
  );

  test(
    'npm run typecheck passes',
    () => {
      run('npm run typecheck', app);
    },
    TEN_MINUTES,
  );

  test(
    'npm test passes (app Jest and API node --test)',
    () => {
      // Jest reports its summary on stderr.
      const out = run('npm test 2>&1', app);
      // Jest: no failures, at least one test passed.
      const jest = out.match(/Tests:\s+(.*?)\s+total/);
      expect(jest).not.toBeNull();
      expect(jest![1]).not.toMatch(/failed/);
      expect(Number(jest![1].match(/(\d+) passed/)?.[1] ?? 0)).toBeGreaterThan(
        0,
      );
      // node --test: no failures, at least one test passed.
      expect(out).toMatch(/# fail 0\b/);
      // Includes the storage load-order test and the wait-for-fuseki test.
      expect(out).toMatch(/storage\.test\.ts/);
      expect(Number(out.match(/# pass (\d+)/)?.[1] ?? 0)).toBeGreaterThan(0);
    },
    TEN_MINUTES,
  );

  test(
    'the shapes build emits .js specifiers in lib/esm',
    () => {
      run(`npm run build -w packages/${PREFIX}-shapes`, app);
      const esm = path.join(app, 'packages', `${PREFIX}-shapes`, 'lib', 'esm');
      const index = fs.readFileSync(path.join(esm, 'index.js'), 'utf8');
      expect(index).toContain("from './shapes/Example.js'");
      expect(index).toContain("import './package.js'");
      expect(
        fs.readFileSync(path.join(esm, 'shapes', 'Example.js'), 'utf8'),
      ).toContain("from '../package.js'");
      // And Node can load it (no ERR_MODULE_NOT_FOUND).
      const out = run(
        `node -e "import('${path.join(esm, 'index.js')}').then((m) => console.log(Object.keys(m).join(',')))"`,
        app,
      );
      expect(out).toContain('Example');
    },
    TEN_MINUTES,
  );

  test(
    'expo export bundles for iOS',
    () => {
      const dist = path.join(tmp, 'dist');
      const out = run(
        `npx expo export --platform ios --output-dir "${dist}" 2>&1`,
        path.join(app, 'apps', 'mobile'),
      );
      expect(out).toMatch(/iOS Bundled/);
      expect(fs.existsSync(dist)).toBe(true);
    },
    TEN_MINUTES,
  );
});
