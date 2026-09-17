export type AppBuildTarget = 'web' | 'capacitor';

export interface BuildAppOptions {
  environments: string[];
  target?: AppBuildTarget;
}

export interface AppPublishConfig {
  staticAssets?: string[];
}

export interface LinkedAppReleaseDestination {
  bucket: string;
  destinationPrefix: string;
  publicBaseUrl?: string;
  endpoint?: string;
}

export interface LinkedAppReleaseFile {
  sourcePath: string;
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
  publicRoot: string;
  destination: LinkedAppReleaseDestination;
  files: LinkedAppReleaseFile[];
}

export interface PublishPlan {
  manifestPath: string;
  destination: LinkedAppReleaseDestination;
  files: LinkedAppReleaseFile[];
  totalBytes: number;
}

export interface PublishResult {
  releaseId: string;
  uploadedFiles: number;
  uploadedBytes: number;
  dryRun: boolean;
}

