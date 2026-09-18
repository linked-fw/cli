import type {IArtifactStore} from '@_linked/core/interfaces/IArtifactStore';
import {assertArtifactStore} from '../app-release/storage-adapter.js';
import {planReleasePublish, publishRelease} from '../app-release/publisher.js';

export interface PublishAppOptions {
  appRoot?: string;
  manifestPath?: string;
  store: IArtifactStore;
  yes?: boolean;
}

const secretEnvironmentKeys = [
  'AWS_SECRET_ACCESS_KEY',
  'STATIC_AWS_SECRET_ACCESS_KEY',
  'UPLOADS_AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'STATIC_AWS_ACCESS_KEY_ID',
  'UPLOADS_AWS_ACCESS_KEY_ID',
];

export const redactPublishError = (error: unknown): Error => {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of secretEnvironmentKeys) {
    const value = process.env[key];
    if (value) message = message.split(value).join('[REDACTED]');
  }
  return new Error(message);
};

export const publishApp = async (options: PublishAppOptions) => {
  const appRoot = options.appRoot || process.cwd();
  const store = assertArtifactStore(options.store);
  try {
    // This command reuses a completed build. It validates the manifest and
    // destination before dry-run output or any confirmed retry upload.
    console.log('🔄 Validating release manifest and destination...');
    const plan = planReleasePublish({
      appRoot,
      manifestPath: options.manifestPath,
      store,
    });

    console.log(
      `Release destination: ${plan.destination.bucket}/${plan.destination.destinationPrefix}`,
    );
    console.log(`Artifacts: ${plan.files.length} (${plan.totalBytes} bytes)`);
    if (!options.yes) {
      console.log('Dry run only; pass --yes to upload this release.');
    }

    console.log('✅ Release plan validated');
    if (options.yes) {
      console.log('🔄 Uploading and verifying release artifacts...');
    }
    const result = await publishRelease({...options, appRoot, store});
    if (result.dryRun) {
      console.log('✅ Dry run complete; no files uploaded');
    } else {
      console.log(
        `✅ Release upload complete: ${result.uploadedFiles} files, ${result.uploadedBytes} bytes`,
      );
    }
    return result;
  } catch (error) {
    throw redactPublishError(error);
  }
};
