import path from 'path';
import {
  findBackendFilesConfig,
  loadBackendFileStorage,
} from '../../src/lifecycle.js';

// build-app and publish-app resolve the appAssets store through
// loadBackendFileStorage: the app's linked.backend.files.{ts,js} when it has
// one, so a build never evaluates the storage file's dataset stores (a
// RemoteDataset's init() pings its data server), else the whole storage file
// as before (cli report 020).
describe('findBackendFilesConfig', () => {
  const root = '/app';
  const existing = (...names: string[]) => (p: string) =>
    names.map((n) => path.join(root, n)).includes(p);

  test('finds linked.backend.files.ts', () => {
    expect(findBackendFilesConfig(root, existing('linked.backend.files.ts'))).toBe(
      path.join(root, 'linked.backend.files.ts'),
    );
  });

  test('finds linked.backend.files.js', () => {
    expect(findBackendFilesConfig(root, existing('linked.backend.files.js'))).toBe(
      path.join(root, 'linked.backend.files.js'),
    );
  });

  test('prefers .ts when both exist', () => {
    expect(
      findBackendFilesConfig(
        root,
        existing('linked.backend.files.js', 'linked.backend.files.ts'),
      ),
    ).toBe(path.join(root, 'linked.backend.files.ts'));
  });

  test('a storage file alone is not a files file', () => {
    expect(
      findBackendFilesConfig(root, existing('linked.backend.storage.ts')),
    ).toBeUndefined();
  });
});

describe('loadBackendFileStorage', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('imports only the files file when the app has one', async () => {
    const imported: string[] = [];
    const loadStorageConfig = jest.fn(async () => undefined);
    await loadBackendFileStorage({
      find: () => '/app/linked.backend.files.ts',
      importFile: async (file) => {
        imported.push(file);
      },
      loadStorageConfig,
    });
    expect(imported).toEqual(['/app/linked.backend.files.ts']);
    expect(loadStorageConfig).not.toHaveBeenCalled();
  });

  test('falls back to the storage file when there is no files file', async () => {
    const importFile = jest.fn(async () => undefined);
    const loadStorageConfig = jest.fn(async () => undefined);
    await loadBackendFileStorage({
      find: () => undefined,
      importFile,
      loadStorageConfig,
    });
    expect(loadStorageConfig).toHaveBeenCalledTimes(1);
    expect(importFile).not.toHaveBeenCalled();
  });

  test('an error in the files file is not swallowed into a fallback', async () => {
    const loadStorageConfig = jest.fn(async () => undefined);
    await expect(
      loadBackendFileStorage({
        find: () => '/app/linked.backend.files.ts',
        importFile: async () => {
          throw new Error('boom');
        },
        loadStorageConfig,
      }),
    ).rejects.toThrow('boom');
    expect(loadStorageConfig).not.toHaveBeenCalled();
  });
});
