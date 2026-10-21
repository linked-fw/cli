// A package's ontology data is Turtle next to its compiled module, read at
// runtime through `import.meta.url` (`@_linked/core/ontology/loadOntologyFiles`).
// These cases measure that the data is reachable in every mode an app runs in:
// the release backend build (the app's own Turtle copied into `lib/`, installed
// packages external and reading their own `lib/esm/data/`), the dev server's
// SSR runner (standalone, where installed packages are bundled through Vite,
// and workspace, where a package resolves to its `src/`), and that the client
// build is unharmed.
//
// Each mode runs in a child process over `tests/fixtures/ontology-app/measure.mjs`
// (Vite is ESM-only, Jest runs CommonJS), which imports the CLI from its built
// `lib/esm`: run `npx linked build` first.
import {execFileSync} from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'ontology-app');
const MEASURE = path.join(FIXTURE, 'measure.mjs');
const CLI_LIB = path.join(__dirname, '..', '..', 'lib', 'esm', 'vite-config.js');

const APP_TTL = fs.readFileSync(path.join(FIXTURE, 'app', 'src', 'data', 'probe.ttl'), 'utf8');
const PKG_TTL = fs.readFileSync(
  path.join(FIXTURE, 'installed', 'probe-ont', 'lib', 'esm', 'data', 'p.ttl'),
  'utf8',
);
const WS_TTL = fs.readFileSync(
  path.join(FIXTURE, 'workspace', 'ws-ont', 'src', 'data', 'w.ttl'),
  'utf8',
);

type Loaded = {text: string; url: string};

const roots: string[] = [];

/** A copy of the fixture app with `@_linked/probe-ont` installed. */
const makeApp = (workspace = false) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-ontology-app-')));
  roots.push(root);
  fs.copySync(path.join(FIXTURE, 'app'), root);
  fs.copySync(
    path.join(FIXTURE, 'installed', 'probe-ont'),
    path.join(root, 'node_modules', '@_linked', 'probe-ont'),
  );
  if (workspace) {
    const pkg = fs.readJsonSync(path.join(root, 'package.json'));
    pkg.workspaces = ['packages/*'];
    pkg.dependencies['ws-ont'] = '*';
    fs.writeJsonSync(path.join(root, 'package.json'), pkg);
    fs.copySync(path.join(FIXTURE, 'workspace', 'ws-ont'), path.join(root, 'packages', 'ws-ont'));
    fs.ensureSymlinkSync(
      path.join(root, 'packages', 'ws-ont'),
      path.join(root, 'node_modules', 'ws-ont'),
      'dir',
    );
    fs.writeFileSync(
      path.join(root, 'src', 'ws.ts'),
      "export {loadData, moduleUrl} from 'ws-ont/ontologies/w.js';\n",
    );
  }
  return root;
};

const measure = <T>(mode: 'release' | 'dev' | 'client', root: string): T => {
  const out = execFileSync(process.execPath, [MEASURE, mode, root], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    env: {...process.env, NODE_ENV: ''},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out.trim().split('\n').pop() ?? '') as T;
};

beforeAll(() => {
  if (!fs.existsSync(CLI_LIB)) {
    throw new Error('ontologyDataReachable needs the built CLI: run `npx linked build` first');
  }
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, {recursive: true, force: true});
});

describe('ontology data reaches its module in every mode', () => {
  test('the release backend reads the app’s own and an installed package’s Turtle', () => {
    const root = makeApp();
    const result = measure<{
      app: Loaded;
      pkg: Loaded;
      copied: number;
      probeJsImportMetaUrl: number;
      libFiles: string[];
    }>('release', root);

    // The app's Turtle sits beside the compiled module at the same relative path.
    expect(result.copied).toBe(1);
    expect(result.libFiles).toContain(path.join('data', 'probe.ttl'));
    expect(result.app.text).toBe(APP_TTL);
    expect(result.app.url).toBe('file://' + path.join(root, 'lib', 'ontologies', 'probe.js'));
    // `import.meta.url` is left for Node to fill in, not inlined to a build-machine path.
    expect(result.probeJsImportMetaUrl).toBeGreaterThanOrEqual(1);
    // The installed package stays external and reads its own lib/esm/data/.
    expect(result.libFiles.some((f) => f.includes('probe-ont'))).toBe(false);
    expect(result.pkg.text).toBe(PKG_TTL);
    expect(result.pkg.url).toBe(
      'file://' + path.join(root, 'node_modules', '@_linked', 'probe-ont', 'lib', 'esm', 'ontologies', 'p.js'),
    );
  }, 120_000);

  test('the dev SSR runner of a standalone app reads both, with the module’s own file URL', () => {
    const root = makeApp();
    const result = measure<{app: Loaded; pkg: Loaded}>('dev', root);

    expect(result.app.text).toBe(APP_TTL);
    expect(result.app.url).toBe('file://' + path.join(root, 'src', 'ontologies', 'probe.ts'));
    // Bundled through the SSR runner (STANDALONE_SSR_BUNDLED), still its real file.
    expect(result.pkg.text).toBe(PKG_TTL);
    expect(result.pkg.url).toBe(
      'file://' + path.join(root, 'node_modules', '@_linked', 'probe-ont', 'lib', 'esm', 'ontologies', 'p.js'),
    );
  }, 120_000);

  test('the dev SSR runner of a workspace app reads a workspace package’s src/ Turtle', () => {
    const root = makeApp(true);
    const result = measure<{app: Loaded; pkg: Loaded; ws: Loaded}>('dev', root);

    expect(result.app.text).toBe(APP_TTL);
    expect(result.pkg.text).toBe(PKG_TTL);
    expect(result.ws.text).toBe(WS_TTL);
    expect(result.ws.url).toBe('file://' + path.join(root, 'packages', 'ws-ont', 'src', 'ontologies', 'w.ts'));
  }, 120_000);

  test('the client build is unharmed and carries no Turtle', () => {
    const root = makeApp();
    const result = measure<{files: string[]; ttlContent: string[]; warnings: string[]}>('client', root);

    expect(result.files.length).toBeGreaterThan(0);
    expect(result.ttlContent).toEqual([]);
    // The loader's `import('node:fs/promises')` is never called in the browser;
    // Vite only notes that it externalized the builtin, once per module that
    // imports it, plus Rollup's empty chunk for the stub. Nothing else is reported.
    const externalized =
      '[plugin vite:resolve] Module "node:fs/promises" has been externalized for browser compatibility, imported by <module>. See https://vite.dev/guide/troubleshooting.html#module-externalized-for-browser-compatibility for more details.';
    expect(
      result.warnings.map((w) => w.replace(/imported by ".*?"/, 'imported by <module>')),
    ).toEqual([externalized, externalized, 'Generated an empty chunk: "__vite-browser-external".']);
  }, 120_000);
});
