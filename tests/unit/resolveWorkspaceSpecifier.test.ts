import fs from 'fs';
import os from 'os';
import path from 'path';
import {resolveWorkspaceSpecifier} from '../../src/vite-config';

// A source workspace must resolve every specifier to src WITHOUT a `development`
// -> src export condition: src/ is not published, so packages do not declare one.
// When a subpath's export key does not match a file name, the name lookup misses
// and the workspace's own `exports` (import/default) is mapped from lib/esm back
// to src. Falling through to Vite instead would load the lib/esm copy of that one
// module next to the src copy of the rest of the package — two instances.

const libOnlyExports = (extra: Record<string, unknown> = {}) => ({
  '.': {types: './lib/esm/index.d.ts', import: './lib/esm/index.js'},
  ...extra,
  './*.js': {types: './lib/esm/*.d.ts', import: './lib/esm/*.js'},
  './*': {types: './lib/esm/*.d.ts', import: './lib/esm/*.js'},
});

function makeWorkspace(
  root: string,
  name: string,
  exportsField: unknown,
  files: string[],
) {
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({name, type: 'module', exports: exportsField}),
  );
  for (const f of files) {
    const full = path.join(root, 'src', f);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, 'export {};\n');
  }
  return {name, srcDir: path.join(root, 'src')};
}

describe('resolveWorkspaceSpecifier', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-resolve-ws-')),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  test('a renamed subpath resolves to src through exports (translation key-sync/node)', async () => {
    const ws = makeWorkspace(
      path.join(tmp, 'translation'),
      '@_linked/translation',
      libOnlyExports({
        './key-sync/node': {
          types: './lib/esm/key-sync-node.d.ts',
          import: './lib/esm/key-sync-node.js',
        },
      }),
      ['index.ts', 'key-sync.ts', 'key-sync-node.ts'],
    );
    expect(
      await resolveWorkspaceSpecifier('@_linked/translation/key-sync/node', [
        ws,
      ]),
    ).toBe(path.join(ws.srcDir, 'key-sync-node.ts'));
  });

  test('a directory subpath resolves to its index in src through exports', async () => {
    const ws = makeWorkspace(
      path.join(tmp, 'documents'),
      '@_linked/documents',
      libOnlyExports({
        './conformance': {
          types: './lib/esm/conformance/index.d.ts',
          import: './lib/esm/conformance/index.js',
        },
      }),
      ['index.ts', 'conformance/index.ts', 'conformance/claims.ts'],
    );
    expect(
      await resolveWorkspaceSpecifier('@_linked/documents/conformance', [ws]),
    ).toBe(path.join(ws.srcDir, 'conformance', 'index.ts'));
    // A file inside the directory still resolves by name.
    expect(
      await resolveWorkspaceSpecifier(
        '@_linked/documents/conformance/claims.js',
        [ws],
      ),
    ).toBe(path.join(ws.srcDir, 'conformance', 'claims.ts'));
  });

  test('a bare name whose src has no index resolves through exports, .tsx included', async () => {
    const ws = makeWorkspace(
      path.join(tmp, 'ui'),
      '@x/ui',
      {'.': {types: './lib/esm/main.d.ts', import: './lib/esm/main.js'}},
      ['main.tsx'],
    );
    expect(await resolveWorkspaceSpecifier('@x/ui', [ws])).toBe(
      path.join(ws.srcDir, 'main.tsx'),
    );
  });

  test('name-based mapping wins over exports', async () => {
    const ws = makeWorkspace(
      path.join(tmp, 'pkg'),
      '@x/pkg',
      libOnlyExports({'./foo': {import: './lib/esm/bar.js'}}),
      ['index.ts', 'foo.ts', 'bar.ts'],
    );
    expect(await resolveWorkspaceSpecifier('@x/pkg/foo', [ws])).toBe(
      path.join(ws.srcDir, 'foo.ts'),
    );
    expect(await resolveWorkspaceSpecifier('@x/pkg', [ws])).toBe(
      path.join(ws.srcDir, 'index.ts'),
    );
  });

  test('an export outside lib/esm, or with no source behind it, falls through', async () => {
    const ws = makeWorkspace(
      path.join(tmp, 'pkg'),
      '@x/pkg',
      {
        './package.json': './package.json',
        './gone': {import: './lib/esm/gone.js'},
        './dev-only': {development: './src/dev.ts'},
      },
      ['index.ts', 'dev.ts'],
    );
    expect(
      await resolveWorkspaceSpecifier('@x/pkg/package.json', [ws]),
    ).toBeNull();
    expect(await resolveWorkspaceSpecifier('@x/pkg/gone', [ws])).toBeNull();
    // `development` is not a condition this resolver honours.
    expect(await resolveWorkspaceSpecifier('@x/pkg/dev-only', [ws])).toBeNull();
    expect(await resolveWorkspaceSpecifier('@other/pkg', [ws])).toBeNull();
  });
});
