export type AppBuildTarget = 'web' | 'capacitor';

export interface BuildAppOptions {
  environments: string[];
  target?: AppBuildTarget;
}

export interface AppPublishConfig {
  /** Extra files under `public/` to ship besides the Vite bundle output. */
  staticAssets?: string[];
  /**
   * Base key every release is nested under. The release prefix becomes
   * `<releasePrefix>/<releaseId>`. Defaults to `releases`.
   */
  releasePrefix?: string;
}

/**
 * Where a release was built for. `accessURL` is the base URL of the file store
 * that produced the manifest (see `IFileStore.accessURL`); publishing refuses
 * to run against a store whose `accessURL` no longer matches, so a staging
 * build can never be pushed to production by swapping config.
 */
export interface LinkedAppReleaseDestination {
  accessURL: string;
  /** Key prefix every object of this release lives under. */
  releasePrefix: string;
  /**
   * Public URL the release's client bundle is served from — `accessURL`,
   * the release prefix and the Vite output directory joined. The build passes
   * it to Vite as `base`, so the bundle's own asset URLs resolve under the
   * release prefix with no server rewrite. Empty for a Capacitor build.
   */
  baseURL: string;
}

export interface LinkedAppReleaseFile {
  /** Path relative to the app root, used to read the file back at publish time. */
  sourcePath: string;
  /** Key in the file store, always under the release prefix. */
  objectKey: string;
  sha256: string;
  size: number;
  contentType: string;
  cacheControl: string;
}

export interface LinkedAppReleaseManifest {
  schemaVersion: 1;
  appName: string;
  appVersion: string;
  releaseId: string;
  target: AppBuildTarget;
  publishable: boolean;
  builtAt: string;
  environmentNames: string[];
  destination: LinkedAppReleaseDestination;
  files: LinkedAppReleaseFile[];
}

export interface PublishPlan {
  releaseId: string;
  manifestPath: string;
  manifestObjectKey: string;
  destination: LinkedAppReleaseDestination;
  files: LinkedAppReleaseFile[];
  totalBytes: number;
}

export interface PublishResult {
  releaseId: string;
  uploadedFiles: number;
  uploadedBytes: number;
  dryRun: boolean;
  /** Object keys whose upload could not be verified against a store hash. */
  unverified: string[];
}
