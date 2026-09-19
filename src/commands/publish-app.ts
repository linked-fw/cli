import type {IFileStore} from '@_linked/core/interfaces/IFileStore';
import {planReleasePublish, publishRelease} from '../app-release/publisher.js';

interface ProgressSpinner {
  text: string;
  succeed(message: string): void;
  fail(message: string): void;
}

export interface PublishAppOptions {
  appRoot?: string;
  manifestPath?: string;
  store: IFileStore;
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
  const source = error instanceof Error ? error : new Error(String(error));
  let message = source.message;
  let stack = source.stack;
  for (const key of secretEnvironmentKeys) {
    const value = process.env[key];
    if (value) {
      message = message.split(value).join('[REDACTED]');
      stack = stack?.split(value).join('[REDACTED]');
    }
  }
  source.message = message;
  if (stack) source.stack = stack;
  return source;
};

export const publishApp = async (options: PublishAppOptions) => {
  const appRoot = options.appRoot || process.cwd();
  let progressSpinner: ProgressSpinner | undefined;
  try {
    // This command reuses a completed build. It validates the manifest and
    // destination before dry-run output or any confirmed upload.
    console.log('🔄 Validating release manifest and destination...');
    const plan = planReleasePublish({
      appRoot,
      manifestPath: options.manifestPath,
      store: options.store,
    });

    console.log(`Release: ${plan.releaseId}`);
    console.log(
      `Destination: ${plan.destination.accessURL || '(no accessURL)'} under ${
        plan.destination.releasePrefix
      }/`,
    );
    console.log(`Artifacts: ${plan.files.length} (${plan.totalBytes} bytes)`);
    if (!options.yes) {
      console.log('Dry run only; pass --yes to upload this release.');
    }

    console.log('✅ Release plan validated');
    if (options.yes) {
      console.log('🔄 Uploading and verifying release artifacts...');
      const total = plan.files.length + 1;
      if (process.stdout.isTTY) {
        // ora is ESM-only, so load it only for an interactive terminal. CI and
        // PM2 use the periodic plain-text progress branch below.
        const {default: ora} = await import('ora');
        progressSpinner = ora({
          discardStdin: true,
          text: `Publishing 0/${total} files`,
        }).start();
      }
    }
    let lastLoggedProgress = 0;
    const result = await publishRelease({
      appRoot,
      manifestPath: options.manifestPath,
      store: options.store,
      yes: options.yes,
      onWarning: (message) => {
        // Printed once per run, not once per file.
        if (progressSpinner) {
          progressSpinner.text = message;
        }
        console.warn(`⚠️  ${message}`);
      },
      onProgress: ({completed, total}) => {
        const message = `Publishing ${completed}/${total} files`;
        if (progressSpinner) {
          progressSpinner.text = message;
        } else if (completed === total || completed - lastLoggedProgress >= 25) {
          console.log(message);
          lastLoggedProgress = completed;
        }
      },
    });
    if (result.dryRun) {
      console.log('✅ Dry run complete; no files uploaded');
    } else {
      const completedMessage = `Release ${result.releaseId} uploaded: ${result.uploadedFiles} files, ${result.uploadedBytes} bytes`;
      progressSpinner?.succeed(completedMessage);
      if (!progressSpinner) console.log(`✅ ${completedMessage}`);
      progressSpinner = undefined;
      if (result.unverified.length) {
        console.warn(
          `⚠️  ${result.unverified.length} of ${result.uploadedFiles} objects could not be verified against a store hash.`,
        );
      }
    }
    return result;
  } catch (error) {
    progressSpinner?.fail('Release upload failed');
    throw redactPublishError(error);
  }
};
