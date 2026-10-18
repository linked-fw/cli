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
