import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ArtifactMetadata,
  IArtifactStore,
  PutArtifactInput,
} from '@_linked/core/interfaces/IArtifactStore';
import {publishRelease} from '../../src/app-release/publisher.js';
import {publishApp} from '../../src/commands/publish-app.js';
import type {LinkedAppReleaseManifest} from '../../src/app-release/types.js';

class MemoryArtifactStore implements IArtifactStore {
  writes: PutArtifactInput[] = [];
  failKey?: string;
  verificationOverride?: Partial<ArtifactMetadata>;

  describeDestination() {
    return {
      bucket: 'pg-cn-staging',
      prefix: '4.2.6',
      endpoint: 'https://spaces.example',
      publicBaseUrl: 'https://cdn.example/4.2.6',
    };
  }

  async putArtifact(input: PutArtifactInput) {
    if (input.key === this.failKey) throw new Error(`failed ${input.key}`);
    this.writes.push(input);
    return {key: input.key};
  }

  async statArtifact(key: string): Promise<ArtifactMetadata> {
    const write = this.writes.find((entry) => entry.key === key)!;
    return {
      key,
      size: Buffer.byteLength(write.body),
      sha256: write.sha256,
      ...this.verificationOverride,
    };
  }
}

describe('release publisher', () => {
  let appRoot: string;
  let store: MemoryArtifactStore;

  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-publish-'));
    store = new MemoryArtifactStore();
    fs.mkdirSync(path.join(appRoot, 'public/bundles'), {recursive: true});
    fs.writeFileSync(path.join(appRoot, 'public/bundles/a.12345678.js'), 'aaa');
    fs.writeFileSync(path.join(appRoot, 'public/bundles/b.12345678.css'), 'bbbb');
    const file = (sourcePath: string, content: string) => ({
      sourcePath,
      objectKey: sourcePath,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      contentType: sourcePath.endsWith('.js') ? 'text/javascript' : 'text/css',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    const manifest: LinkedAppReleaseManifest = {
      schemaVersion: 1,
      appName: 'peacegame',
      appVersion: '4.2.6',
      releaseId: '4.2.6-abc123',
      target: 'web',
      publishable: true,
      builtAt: '2026-09-17T00:00:00.000Z',
      environmentNames: ['cn-staging'],
      publicRoot: 'public',
      destination: {
        bucket: 'pg-cn-staging',
        destinationPrefix: '4.2.6',
        endpoint: 'https://spaces.example',
        publicBaseUrl: 'https://cdn.example/4.2.6',
      },
      files: [
        file('public/bundles/a.12345678.js', 'aaa'),
        file('public/bundles/b.12345678.css', 'bbbb'),
      ],
    };
    fs.writeFileSync(
      path.join(appRoot, 'public/bundles/linked-release.json'),
      JSON.stringify(manifest),
    );
  });

  afterEach(() => fs.rmSync(appRoot, {recursive: true, force: true}));

  test('dry run performs zero writes', async () => {
    const result = await publishRelease({appRoot, store});
    expect(result).toMatchObject({dryRun: true, uploadedFiles: 0});
    expect(store.writes).toHaveLength(0);
  });

  test('confirmed publish uploads assets before the release manifest', async () => {
    await publishRelease({appRoot, store, yes: true});
    expect(store.writes.map((write) => write.key)).toEqual([
      'public/bundles/a.12345678.js',
      'public/bundles/b.12345678.css',
      'public/bundles/linked-release.json',
    ]);
  });

  test('rejects a mobile manifest without writes', async () => {
    const manifestPath = path.join(appRoot, 'public/bundles/linked-release.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.target = 'capacitor';
    manifest.publishable = false;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'Only publishable web release manifests',
    );
    expect(store.writes).toHaveLength(0);
  });

  test('rejects a destination mismatch without writes', async () => {
    jest.spyOn(store, 'describeDestination').mockReturnValue({
      bucket: 'pg-prod', prefix: '4.2.6',
    });
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'Static destination does not match',
    );
    expect(store.writes).toHaveLength(0);
  });

  test('rejects a changed local file before any write', async () => {
    fs.writeFileSync(path.join(appRoot, 'public/bundles/a.12345678.js'), 'changed');
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'changed after build',
    );
    expect(store.writes).toHaveLength(0);
  });

  test('does not upload the release manifest after a partial failure', async () => {
    store.failKey = 'public/bundles/b.12345678.css';
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'failed public/bundles/b.12345678.css',
    );
    expect(store.writes.map((write) => write.key)).toEqual([
      'public/bundles/a.12345678.js',
    ]);
  });

  test('fails when uploaded metadata does not verify', async () => {
    store.verificationOverride = {size: 999};
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'verification failed',
    );
  });

  test('redacts configured credentials from upload errors', async () => {
    const secret = 'super-secret-value';
    process.env.STATIC_AWS_SECRET_ACCESS_KEY = secret;
    store.putArtifact = async () => {
      throw new Error(`provider rejected ${secret}`);
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(publishApp({appRoot, store, yes: true})).rejects.toThrow(
        'provider rejected [REDACTED]',
      );
    } finally {
      delete process.env.STATIC_AWS_SECRET_ACCESS_KEY;
      log.mockRestore();
    }
  });
});
