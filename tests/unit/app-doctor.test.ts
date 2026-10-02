import fs from 'fs';
import os from 'os';
import path from 'path';
import {scanLinkedClientDeps} from '../../src/client-dep-includes';
import {
  diagnose,
  notAnAppReason,
  resolveIncludeEntry,
  runAppDoctor,
} from '../../src/commands/app-doctor';

// `linked app-doctor` warns about what otherwise only fails in the browser: an
// include entry that resolves to nothing, and the React peer mismatch that makes
// npm nest a framework package's dependency in the first place.

function write(file: string, content: string | object) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
}

describe('linked app-doctor', () => {
  let app: string;
  const nm = (...p: string[]) => path.join(app, 'node_modules', ...p);

  beforeEach(() => {
    app = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-doctor-')),
    );
    write(path.join(app, 'package.json'), {
      name: 'app',
      dependencies: {'@_linked/primitives': '*', react: '19.1.0'},
    });
    write(nm('react', 'package.json'), {
      name: 'react',
      version: '19.1.0',
      main: 'index.js',
    });
    write(nm('react', 'index.js'), '');
    write(nm('react-dom', 'package.json'), {
      name: 'react-dom',
      version: '19.1.0',
      main: 'index.js',
    });
    write(nm('react-dom', 'index.js'), '');
    write(nm('@_linked', 'primitives', 'package.json'), {
      name: '@_linked/primitives',
      version: '1.0.0',
      type: 'module',
      linkedPackage: true,
      exports: {'./*': {import: './lib/esm/*.js'}},
      dependencies: {vaul: '^0.9.0', cmdk: '^1.0.0'},
    });
    write(
      nm('@_linked', 'primitives', 'lib', 'esm', 'Drawer.js'),
      "import {Drawer} from 'vaul';\nimport 'cmdk';\nexport {Drawer};\n",
    );
    // vaul 0.9's peer range stops at React 18, so npm nested it under primitives.
    write(
      nm('@_linked', 'primitives', 'node_modules', 'vaul', 'package.json'),
      {
        name: 'vaul',
        version: '0.9.9',
        module: 'index.mjs',
        peerDependencies: {
          react: '^16.8 || ^17.0 || ^18.0',
          'react-dom': '^16.8 || ^17.0 || ^18.0',
        },
      },
    );
    write(
      nm('@_linked', 'primitives', 'node_modules', 'vaul', 'index.mjs'),
      'export const Drawer = 1;\n',
    );
    write(nm('cmdk', 'package.json'), {
      name: 'cmdk',
      version: '1.1.0',
      module: 'index.mjs',
      peerDependencies: {react: '^18 || ^19'},
      exports: {'.': {import: './index.mjs'}, './sub': {import: './sub.mjs'}},
    });
    write(nm('cmdk', 'index.mjs'), '');
    write(nm('cmdk', 'sub.mjs'), '');
  });

  afterEach(() => {
    fs.rmSync(app, {recursive: true, force: true});
  });

  const findingsFor = async (appInclude: string[]) =>
    diagnose({
      cwd: app,
      appInclude,
      scan: await scanLinkedClientDeps(['@_linked/primitives'], {cwd: app}),
    });

  test('resolveIncludeEntry follows nested hops and subpath exports', async () => {
    expect(await resolveIncludeEntry(app, 'vaul')).toBeNull();
    expect(await resolveIncludeEntry(app, '@_linked/primitives > vaul')).toBe(
      nm('@_linked', 'primitives', 'node_modules', 'vaul', 'index.mjs'),
    );
    expect(await resolveIncludeEntry(app, 'cmdk/sub')).toBe(
      nm('cmdk', 'sub.mjs'),
    );
    expect(await resolveIncludeEntry(app, 'cmdk/not-exported')).toBeNull();
    expect(await resolveIncludeEntry(app, 'not-installed')).toBeNull();
  });

  test('an include entry that does not resolve is a warning naming the nested form', async () => {
    const findings = await findingsFor(['vaul']);
    const warning = findings.find((f) =>
      f.message.includes("entry 'vaul' does not resolve"),
    );
    expect(warning?.level).toBe('warn');
    expect(warning?.message).toContain("use '@_linked/primitives > vaul'");
  });

  test('a stale entry for a package that is not installed at all is a warning', async () => {
    const findings = await findingsFor(['gone-package']);
    expect(findings).toContainEqual({
      level: 'warn',
      message: expect.stringContaining("'gone-package' does not resolve"),
    });
  });

  test("a dependency whose React peer range excludes the app's React is a warning suggesting a bump", async () => {
    const findings = await findingsFor([]);
    const peer = findings.filter((f) => f.message.includes('peer range'));
    expect(peer).toHaveLength(1);
    expect(peer[0].level).toBe('warn');
    expect(peer[0].message).toContain(
      '@_linked/primitives depends on vaul@0.9.9',
    );
    expect(peer[0].message).toContain('react 19.1.0');
    expect(peer[0].message).toContain('nested under @_linked/primitives');
    expect(peer[0].message).toContain('Bump vaul in @_linked/primitives');
    // cmdk admits React 19: no warning.
    expect(findings.some((f) => f.message.includes('cmdk@'))).toBe(false);
  });

  test('a peer range that admits the app React is fine', async () => {
    write(
      nm('@_linked', 'primitives', 'node_modules', 'vaul', 'package.json'),
      {
        name: 'vaul',
        version: '1.1.2',
        module: 'index.mjs',
        peerDependencies: {
          react: '^16.8 || ^17.0 || ^18.0 || ^19.0.0 || ^19.0.0-rc',
        },
      },
    );
    expect((await findingsFor([])).filter((f) => f.level === 'warn')).toEqual(
      [],
    );
  });

  test('hand-written entries that are generated anyway are listed as removable, and resolvable ones are not warnings', async () => {
    const findings = await findingsFor([
      '@_linked/primitives > vaul',
      'cmdk',
      'cmdk/sub',
    ]);
    const info = findings.find((f) => f.level === 'info');
    expect(info?.message).toContain(
      '2 optimizeDeps.include entries are generated automatically',
    );
    expect(info?.message).toContain('@_linked/primitives > vaul');
    expect(info?.message).not.toContain('cmdk/sub');
    expect(
      findings.filter((f) => f.message.includes('does not resolve')),
    ).toEqual([]);
  });

  test('outside an app it says so and exits 1, instead of reporting 0 warnings', async () => {
    // The fixture has a package.json and node_modules but no vite.config: a package, not an app.
    expect(notAnAppReason(app)).toMatch(/is not an app — no vite\.config/);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = process.exitCode;
    try {
      await runAppDoctor({cwd: app});
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.join('\n')).toMatch(/is not an app/);
      expect(logSpy.mock.calls.join('\n')).not.toMatch(/0 warnings/);
    } finally {
      process.exitCode = exitCode;
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('a directory with a vite.config is an app', () => {
    write(path.join(app, 'vite.config.ts'), 'export default {};\n');
    expect(notAnAppReason(app)).toBeNull();
  });
});
