import fs from 'fs';
import os from 'os';
import path from 'path';
import {resolveSourceSibling, resolveWorkspaceSpecifier} from '../../src/vite-config';

// A linked package installed from npm that ships `src/` is resolved to source
// (discoverLinkedSourceDependencies). Its relative `./Sibling.js` imports must
// resolve here too: left to Vite, a `.tsx` sibling gets `?v=<hash>` from a
// `.ts` importer and none from a `.tsx` one, so the browser loads it twice
// (shape-ui's hostContext.tsx, report 018). Every import of one file must give
// the id the package-entry path gives.

describe('resolveSourceSibling', () => {
  let tmp: string;
  let srcDir: string;
  const name = '@_linked/shape-ui';

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-')));
    const root = path.join(tmp, 'app/node_modules/@_linked/shape-ui');
    srcDir = path.join(root, 'src');
    fs.mkdirSync(path.join(srcDir, 'components'), {recursive: true});
    fs.mkdirSync(path.join(srcDir, 'shape'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name,
        type: 'module',
        exports: {
          '.': {import: './lib/esm/index.js'},
          './*': {import: './lib/esm/*.js'},
        },
      }),
    );
    for (const f of [
      'index.ts',
      'hostContext.tsx',
      'host.ts',
      'legacy.js',
      'components/InstanceView.tsx',
      'shape/relationShape.ts',
    ]) {
      fs.writeFileSync(path.join(srcDir, f), 'export {};\n');
    }
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  const ws = () => [{name, srcDir}];

  it('resolves a .tsx sibling from .ts and .tsx importers to the package-entry id', async () => {
    const viaEntry = await resolveWorkspaceSpecifier(`${name}/hostContext`, ws());
    expect(viaEntry).toBe(path.join(srcDir, 'hostContext.tsx'));
    const importers = [
      path.join(srcDir, 'index.ts'),
      path.join(srcDir, 'shape/relationShape.ts'),
      path.join(srcDir, 'components/InstanceView.tsx'),
    ];
    for (const importer of importers) {
      const spec = importer.startsWith(path.join(srcDir, 'index'))
        ? './hostContext.js'
        : '../hostContext.js';
      expect(await resolveSourceSibling(spec, importer, ws())).toBe(viaEntry);
    }
  });

  it('accepts .jsx specifiers and an importer id carrying a query', async () => {
    const importer = path.join(srcDir, 'shape/relationShape.ts') + '?v=b4fad9c9';
    expect(await resolveSourceSibling('../hostContext.jsx', importer, ws())).toBe(
      path.join(srcDir, 'hostContext.tsx'),
    );
  });

  it('resolves a .ts sibling and, in a registered src, a literal .js file', async () => {
    const importer = path.join(srcDir, 'index.ts');
    expect(await resolveSourceSibling('./host.js', importer, ws())).toBe(
      path.join(srcDir, 'host.ts'),
    );
    expect(await resolveSourceSibling('./legacy.js', importer, ws())).toBe(
      path.join(srcDir, 'legacy.js'),
    );
  });

  it('leaves non-source importers, bare specifiers and other extensions to Vite', async () => {
    const outside = path.join(tmp, 'app/node_modules/other/index.js');
    expect(await resolveSourceSibling('./hostContext.js', outside, ws())).toBeNull();
    // The installed package with no registered src (lib-only install).
    expect(await resolveSourceSibling('../hostContext.js', path.join(srcDir, 'shape/relationShape.ts'), [])).toBeNull();
    const importer = path.join(srcDir, 'index.ts');
    expect(await resolveSourceSibling('react', importer, ws())).toBeNull();
    expect(await resolveSourceSibling('./InstanceView.module.css', importer, ws())).toBeNull();
    expect(await resolveSourceSibling('./missing.js', importer, ws())).toBeNull();
    expect(await resolveSourceSibling('./hostContext.js', undefined, ws())).toBeNull();
  });

  it('keeps resolving workspace /packages/ importers, without the literal fallback', async () => {
    const pkgSrc = path.join(tmp, 'packages/foo/src');
    fs.mkdirSync(pkgSrc, {recursive: true});
    fs.writeFileSync(path.join(pkgSrc, 'A.tsx'), 'export {};\n');
    fs.writeFileSync(path.join(pkgSrc, 'plain.js'), 'export {};\n');
    const importer = path.join(pkgSrc, 'index.ts');
    expect(await resolveSourceSibling('./A.js', importer, [])).toBe(path.join(pkgSrc, 'A.tsx'));
    expect(await resolveSourceSibling('./plain.js', importer, [])).toBeNull();
  });
});
