import {
  FileStorePurposes,
  LinkedFileStorage,
} from '@_linked/core/utils/LinkedFileStorage';
import type {IFileStore} from '@_linked/core/interfaces/IFileStore';

export interface ResolveAppAssetsStoreDependencies {
  /**
   * Registers the app's file stores on `LinkedFileStorage`: its
   * `linked.backend.files.{ts,js}`, or the whole storage file when it has none
   * (`loadBackendFileStorage`). The module's own exports are not inspected.
   */
  loadStorageConfig?: () => Promise<unknown>;
  /** Injection point for tests. Defaults to `LinkedFileStorage.getStore`. */
  getStore?: (purpose: string) => IFileStore;
}

/**
 * Resolve the store that release artifacts are published to.
 *
 * Apps that dedicate a CDN bucket to bundles configure
 * `LinkedFileStorage.setStore(FileStorePurposes.appAssets, …)`. Apps with a
 * single store configure only a default store and `getStore` falls back to it
 * — that is a supported setup, not an error, so there is no check for a
 * dedicated store here.
 */
export const resolveAppAssetsStore = async (
  dependencies: ResolveAppAssetsStoreDependencies = {},
): Promise<IFileStore> => {
  const loadStorageConfig =
    dependencies.loadStorageConfig ||
    (async () => {
      const {loadBackendFileStorage} = await import('../lifecycle.js');
      return loadBackendFileStorage();
    });
  await loadStorageConfig();

  const getStore =
    dependencies.getStore ||
    ((purpose: string) => LinkedFileStorage.getStore(purpose));
  return getStore(FileStorePurposes.appAssets);
};

/** `accessURL` values are compared ignoring a trailing slash. */
export const normalizeAccessURL = (accessURL: string): string =>
  (accessURL || '').trim().replace(/\/+$/, '');
