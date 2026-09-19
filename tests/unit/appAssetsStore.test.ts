import {
  FileStorePurposes,
  LinkedFileStorage,
} from '@_linked/core/utils/LinkedFileStorage';
import type {IFileStore} from '@_linked/core/interfaces/IFileStore';
import {
  normalizeAccessURL,
  resolveAppAssetsStore,
} from '../../src/app-release/app-assets-store.js';

const makeStore = (accessURL: string): IFileStore =>
  ({
    accessURL,
    async deleteFile() {},
    async fileExists() {
      return false;
    },
    async getFile() {
      return null;
    },
    async listFiles() {
      return [];
    },
    async saveFile() {
      return null;
    },
  }) as IFileStore;

describe('resolveAppAssetsStore', () => {
  afterEach(() => {
    LinkedFileStorage.resetForTests();
    jest.restoreAllMocks();
  });

  test('loads the app storage config before resolving', async () => {
    const order: string[] = [];
    const dedicated = makeStore('https://cdn.example.test');
    await resolveAppAssetsStore({
      loadStorageConfig: async () => {
        order.push('config');
        LinkedFileStorage.setStore(FileStorePurposes.appAssets, dedicated);
      },
      getStore: (purpose) => {
        order.push(`getStore:${purpose}`);
        return LinkedFileStorage.getStore(purpose);
      },
    });
    expect(order).toEqual(['config', 'getStore:appAssets']);
  });

  test('uses a dedicated appAssets store when one is configured', async () => {
    const dedicated = makeStore('https://cdn.example.test');
    const fallback = makeStore('https://uploads.example.test');
    const store = await resolveAppAssetsStore({
      loadStorageConfig: async () => {
        LinkedFileStorage.setDefaultStore(fallback);
        LinkedFileStorage.setStore(FileStorePurposes.appAssets, dedicated);
      },
    });
    expect(store).toBe(dedicated);
    expect(store.accessURL).toBe('https://cdn.example.test');
  });

  test('falls back to the default store when only one store is configured', async () => {
    // An app with a single store must publish without extra configuration:
    // this is the case the previous implementation rejected outright.
    const only = makeStore('https://files.example.test');
    const store = await resolveAppAssetsStore({
      loadStorageConfig: async () => {
        LinkedFileStorage.setDefaultStore(only);
      },
    });
    expect(store).toBe(only);
  });

  test('a store configured for uploads is not used for app assets', async () => {
    const uploads = makeStore('https://uploads.example.test');
    const fallback = makeStore('https://files.example.test');
    const store = await resolveAppAssetsStore({
      loadStorageConfig: async () => {
        LinkedFileStorage.setDefaultStore(fallback);
        LinkedFileStorage.setStore(FileStorePurposes.uploads, uploads);
      },
    });
    expect(store).toBe(fallback);
  });

  test('reports a usable error when no store is configured at all', async () => {
    await expect(
      resolveAppAssetsStore({loadStorageConfig: async () => undefined}),
    ).rejects.toThrow(/no default store is configured/);
  });
});

describe('normalizeAccessURL', () => {
  test.each([
    ['https://cdn.example.test', 'https://cdn.example.test'],
    ['https://cdn.example.test/', 'https://cdn.example.test'],
    ['https://cdn.example.test///', 'https://cdn.example.test'],
    ['  https://cdn.example.test/  ', 'https://cdn.example.test'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAccessURL(input)).toBe(expected);
  });
});
