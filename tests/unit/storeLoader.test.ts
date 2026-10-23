import fs from 'fs';
import os from 'os';
import path from 'path';
import {pathToFileURL} from 'url';
import {
  createStoreLoader,
  STORE_LOADER_KEY,
  type StoreLoaderVite,
} from '../../src/commands/start';

const REMOTE = '@_linked/server/shapes/quadstores/RemoteDataset';
const FUSEKI = '@_linked/fuseki/shapes/FusekiStore';
const CWD = '/app';

function fakeVite(
  noExternal: true | string | RegExp | (string | RegExp)[] | undefined,
  resolved:
    | string
    | null = '/app/node_modules/@_linked/fuseki/lib/esm/shapes/FusekiStore.js',
) {
  const ssrLoadModule = jest.fn(async (id: string) => ({from: 'runner', id}));
  const resolveId = jest.fn(async () => (resolved ? {id: resolved} : null));
  const vite: StoreLoaderVite = {
    config: {ssr: {noExternal}},
    ssrLoadModule,
    environments: {ssr: {pluginContainer: {resolveId}}},
  };
  const nativeImport = jest.fn(async (id: string) => ({from: 'node', id}));
  return {vite, ssrLoadModule, resolveId, nativeImport};
}

describe('createStoreLoader', () => {
  it('is installed under the key core reads', () => {
    expect(STORE_LOADER_KEY).toBe(Symbol.for('@_linked/core:importModule'));
  });

  it('loads a store from a bundled package through ssrLoadModule', async () => {
    const f = fakeVite([/^@_linked\/(?!(core|cli)$)/]);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport);
    await expect(load(REMOTE)).resolves.toEqual({from: 'runner', id: REMOTE});
    expect(f.ssrLoadModule).toHaveBeenCalledWith(REMOTE);
    expect(f.resolveId).not.toHaveBeenCalled();
    expect(f.nativeImport).not.toHaveBeenCalled();
  });

  it('loads a store from an external package through Node, at the file Vite resolves', async () => {
    const file =
      '/app/node_modules/@_linked/fuseki/lib/esm/shapes/FusekiStore.js';
    const f = fakeVite(['@_linked/server'], file);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport);
    await expect(load(FUSEKI)).resolves.toEqual({
      from: 'node',
      id: pathToFileURL(file).href,
    });
    expect(f.resolveId).toHaveBeenCalledWith(
      FUSEKI,
      path.join(CWD, 'index.js'),
    );
    expect(f.ssrLoadModule).not.toHaveBeenCalled();
  });

  it('sends every store to ssrLoadModule when noExternal is true', async () => {
    const f = fakeVite(true);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport);
    await load(FUSEKI);
    await load(REMOTE);
    expect(f.ssrLoadModule.mock.calls).toEqual([[FUSEKI], [REMOTE]]);
    expect(f.nativeImport).not.toHaveBeenCalled();
  });

  it('falls back to the bare specifier when the resolver returns nothing', async () => {
    const f = fakeVite([], null);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport);
    await expect(load(FUSEKI)).resolves.toEqual({from: 'node', id: FUSEKI});
  });

  it('treats a missing noExternal as bundling nothing', async () => {
    const f = fakeVite(undefined);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport);
    await load(REMOTE);
    expect(f.ssrLoadModule).not.toHaveBeenCalled();
    expect(f.nativeImport).toHaveBeenCalled();
  });

  it('accepts a single string or RegExp entry', async () => {
    for (const entry of ['@_linked/server', /^@_linked\/server$/]) {
      const f = fakeVite(entry);
      await createStoreLoader(f.vite, CWD, f.nativeImport)(REMOTE);
      expect(f.ssrLoadModule).toHaveBeenCalledWith(REMOTE);
    }
  });
});

describe('createStoreLoader with a file path', () => {
  const SERVER_REGISTER = path.resolve(
    '/app/node_modules/@_linked/server/lib/esm/ontologies/server.register.js',
  );
  const FUSEKI_REGISTER = path.resolve(
    '/app/node_modules/@_linked/fuseki/lib/esm/ontologies/fuseki.register.js',
  );
  const STANDALONE = [/^@_linked\/(?!(core|cli)$)/];
  const vid = (file: string) => file.split(path.sep).join('/');

  it('loads a file of a bundled package through ssrLoadModule', async () => {
    const f = fakeVite(STANDALONE);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
      discoverSourceWorkspaces: async () => [],
    });
    await expect(load(SERVER_REGISTER)).resolves.toEqual({
      from: 'runner',
      id: vid(SERVER_REGISTER),
    });
    expect(f.nativeImport).not.toHaveBeenCalled();
    expect(f.resolveId).not.toHaveBeenCalled();
  });

  it('accepts a file: URL like the path', async () => {
    const f = fakeVite(STANDALONE);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
      discoverSourceWorkspaces: async () => [],
    });
    await load(pathToFileURL(SERVER_REGISTER).href);
    expect(f.ssrLoadModule).toHaveBeenCalledWith(vid(SERVER_REGISTER));
  });

  it('imports a file of an external package natively, never through the runner', async () => {
    const f = fakeVite(['@_linked/server']);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport);
    await expect(load(FUSEKI_REGISTER)).resolves.toEqual({
      from: 'node',
      id: pathToFileURL(FUSEKI_REGISTER).href,
    });
    expect(f.ssrLoadModule).not.toHaveBeenCalled();
    // A path needs no resolution.
    expect(f.resolveId).not.toHaveBeenCalled();
  });

  it('imports a file in no package natively', async () => {
    const f = fakeVite(true);
    const file = path.resolve('/elsewhere/x.js');
    const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
      packageOf: () => null,
    });
    await expect(load(file)).resolves.toEqual({
      from: 'node',
      id: pathToFileURL(file).href,
    });
  });

  describe('a source workspace', () => {
    let root: string;
    let pkgDir: string;
    beforeAll(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-loader-'));
      pkgDir = path.join(root, 'packages', 'pets');
      fs.mkdirSync(path.join(pkgDir, 'src', 'ontologies'), {recursive: true});
      fs.mkdirSync(path.join(pkgDir, 'lib', 'esm', 'ontologies'), {recursive: true});
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"@acme/pets"}');
      fs.writeFileSync(path.join(pkgDir, 'src/ontologies/pets.register.ts'), '');
      fs.writeFileSync(path.join(pkgDir, 'lib/esm/ontologies/pets.register.js'), '');
      fs.writeFileSync(path.join(pkgDir, 'lib/esm/ontologies/built-only.register.js'), '');
    });
    afterAll(() => fs.rmSync(root, {recursive: true, force: true}));

    const workspace = () => ({name: '@acme/pets', srcDir: path.join(pkgDir, 'src')});

    it('loads src/<p>.ts in place of lib/esm/<p>.js', async () => {
      const f = fakeVite(['@acme/pets', '@_linked/server']);
      const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
        sourceWorkspaces: [workspace()],
      });
      await load(path.join(pkgDir, 'lib/esm/ontologies/pets.register.js'));
      expect(f.ssrLoadModule).toHaveBeenCalledWith(
        vid(path.join(pkgDir, 'src/ontologies/pets.register.ts')),
      );
      expect(f.nativeImport).not.toHaveBeenCalled();
    });

    it('reads the source workspaces from the resolver plugin by default', async () => {
      const f = fakeVite(['@acme/pets']);
      f.vite.config.plugins = [
        {name: 'other'},
        {name: 'linked:resolve-workspace-ts', api: {sourceWorkspaces: [workspace()]}},
      ];
      const load = createStoreLoader(f.vite, CWD, f.nativeImport);
      await load(path.join(pkgDir, 'lib/esm/ontologies/pets.register.js'));
      expect(f.ssrLoadModule).toHaveBeenCalledWith(
        vid(path.join(pkgDir, 'src/ontologies/pets.register.ts')),
      );
    });

    it('discovers the source workspaces when no plugin exposes them', async () => {
      const f = fakeVite(['@acme/pets']);
      const discover = jest.fn(async () => [workspace()]);
      const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
        discoverSourceWorkspaces: discover,
      });
      await load(path.join(pkgDir, 'lib/esm/ontologies/pets.register.js'));
      await load(path.join(pkgDir, 'lib/esm/ontologies/pets.register.js'));
      expect(f.ssrLoadModule).toHaveBeenLastCalledWith(
        vid(path.join(pkgDir, 'src/ontologies/pets.register.ts')),
      );
      expect(discover).toHaveBeenCalledTimes(1);
    });

    it('loads the lib file through the runner when it has no source', async () => {
      const f = fakeVite(['@acme/pets']);
      const file = path.join(pkgDir, 'lib/esm/ontologies/built-only.register.js');
      const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
        sourceWorkspaces: [workspace()],
      });
      await load(file);
      expect(f.ssrLoadModule).toHaveBeenCalledWith(vid(file));
    });

    it('imports it natively when the runner does not bundle it', async () => {
      const f = fakeVite(['@_linked/server']);
      const file = path.join(pkgDir, 'lib/esm/ontologies/pets.register.js');
      const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
        sourceWorkspaces: [workspace()],
      });
      await expect(load(file)).resolves.toEqual({
        from: 'node',
        id: pathToFileURL(file).href,
      });
      expect(f.ssrLoadModule).not.toHaveBeenCalled();
    });
  });

  it('leaves a specifier as it was', async () => {
    const f = fakeVite(STANDALONE);
    const load = createStoreLoader(f.vite, CWD, f.nativeImport, {
      packageOf: () => {
        throw new Error('a specifier is not a path');
      },
    });
    await load(REMOTE);
    expect(f.ssrLoadModule).toHaveBeenCalledWith(REMOTE);
  });
});
