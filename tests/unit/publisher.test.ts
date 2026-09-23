import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  FileStat,
  IFileStore,
  SaveFileOptions,
} from '@_linked/core/interfaces/IFileStore';
import {publishRelease} from '../../src/app-release/publisher.js';
import {publishApp} from '../../src/commands/publish-app.js';
import type {LinkedAppReleaseManifest} from '../../src/app-release/types.js';

const ACCESS_URL = 'https://cdn.example.test';
const PREFIX = 'releases/4.2.6-abc123';

interface Write {
  key: string;
  body: Buffer;
  options?: SaveFileOptions | string;
}

/**
 * Minimal in-memory `IFileStore`. `statFile` is deliberately declared as an
 * optional own property so a test can delete it and exercise a store that does
 * not implement the optional method at all.
 */
class MemoryFileStore implements IFileStore {
  readonly accessURL: string;
  writes: Write[] = [];
  failKey?: string;
  /** When false, statFile reports no sha256 (the S3-without-checksum case). */
  reportsHash = true;
  sizeOverride?: number;

  constructor(accessURL = ACCESS_URL) {
    this.accessURL = accessURL;
  }

  async saveFile(
    filePath: string,
    fileContent: any,
    options?: SaveFileOptions | string,
  ) {
    if (filePath === this.failKey) throw new Error(`failed ${filePath}`);
    this.writes.push({key: filePath, body: Buffer.from(fileContent), options});
    return `${this.accessURL}/${filePath}`;
  }

  statFile = async (filePath: string): Promise<FileStat | null> => {
    const write = this.writes.find((entry) => entry.key === filePath);
    if (!write) return null;
    return {
      size: this.sizeOverride ?? write.body.byteLength,
      sha256: this.reportsHash
        ? crypto.createHash('sha256').update(write.body).digest('hex')
        : undefined,
      etag: '"not-a-content-hash"',
    };
  };

  async deleteFile() {}
  async fileExists(filePath: string) {
    return this.writes.some((entry) => entry.key === filePath);
  }
  async getFile() {
    return null;
  }
  async listFiles() {
    return this.writes.map((entry) => entry.key);
  }
}

const sha = (content: string) =>
  crypto.createHash('sha256').update(content).digest('hex');

describe('release publisher', () => {
  let appRoot: string;
  let store: MemoryFileStore;

  const writeManifest = (overrides: Partial<LinkedAppReleaseManifest> = {}) => {
    const file = (sourcePath: string, content: string) => ({
      sourcePath,
      objectKey: `${PREFIX}/${sourcePath}`,
      sha256: sha(content),
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
      destination: {
        accessURL: ACCESS_URL,
        releasePrefix: PREFIX,
        baseURL: `${ACCESS_URL}/${PREFIX}/public/bundles/`,
      },
      files: [
        file('public/bundles/a.12345678.js', 'aaa'),
        file('public/bundles/b.12345678.css', 'bbbb'),
      ],
      ...overrides,
    };
    fs.writeFileSync(
      path.join(appRoot, 'public/bundles/linked-release.json'),
      JSON.stringify(manifest),
    );
    return manifest;
  };

  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-publish-'));
    store = new MemoryFileStore();
    fs.mkdirSync(path.join(appRoot, 'public/bundles'), {recursive: true});
    fs.writeFileSync(path.join(appRoot, 'public/bundles/a.12345678.js'), 'aaa');
    fs.writeFileSync(
      path.join(appRoot, 'public/bundles/b.12345678.css'),
      'bbbb',
    );
    writeManifest();
  });

  afterEach(() => fs.rmSync(appRoot, {recursive: true, force: true}));

  test('dry run performs zero writes', async () => {
    const result = await publishRelease({appRoot, store});
    expect(result).toMatchObject({dryRun: true, uploadedFiles: 0});
    expect(store.writes).toHaveLength(0);
  });

  test('uploads every object under the release prefix, manifest last', async () => {
    const progress: string[] = [];
    const result = await publishRelease({
      appRoot,
      store,
      yes: true,
      onProgress: ({completed, total, objectKey}) => {
        progress.push(`${completed}/${total}:${objectKey}`);
      },
    });
    expect(store.writes.map((write) => write.key)).toEqual([
      `${PREFIX}/public/bundles/a.12345678.js`,
      `${PREFIX}/public/bundles/b.12345678.css`,
      `${PREFIX}/public/bundles/linked-release.json`,
    ]);
    expect(progress).toEqual([
      `1/3:${PREFIX}/public/bundles/a.12345678.js`,
      `2/3:${PREFIX}/public/bundles/b.12345678.css`,
      `3/3:${PREFIX}/public/bundles/linked-release.json`,
    ]);
    expect(result.unverified).toEqual([]);
  });

  test('a second release does not overwrite the first', async () => {
    await publishRelease({appRoot, store, yes: true});
    const firstKeys = store.writes.map((write) => write.key);

    writeManifest({
      releaseId: '4.2.7-def456',
      destination: {
        accessURL: ACCESS_URL,
        releasePrefix: 'releases/4.2.7-def456',
        baseURL: `${ACCESS_URL}/releases/4.2.7-def456/public/bundles/`,
      },
      files: [
        {
          sourcePath: 'public/bundles/a.12345678.js',
          objectKey: 'releases/4.2.7-def456/public/bundles/a.12345678.js',
          sha256: sha('aaa'),
          size: 3,
          contentType: 'text/javascript',
          cacheControl: 'public, max-age=31536000, immutable',
        },
      ],
    });
    await publishRelease({appRoot, store, yes: true});

    for (const key of firstKeys) {
      expect(store.writes.filter((write) => write.key === key)).toHaveLength(1);
    }
    expect(store.writes.map((write) => write.key)).toContain(
      'releases/4.2.7-def456/public/bundles/a.12345678.js',
    );
  });

  test('passes mime type, cache control, no-rename, and preservePath for release keys', async () => {
    await publishRelease({appRoot, store, yes: true});
    expect(store.writes[0].options).toEqual({
      mimeType: 'text/javascript',
      cacheControl: 'public, max-age=31536000, immutable',
      preventDuplicates: false,
      preservePath: true,
    });
  });

  test('fails clearly when the store renames the object it was given', async () => {
    // LocalFileStore, for one, lowercases and suffixes the path it is handed.
    store.saveFile = async (filePath: string) =>
      `${ACCESS_URL}/${String(filePath).replace(/\.js$/, '_a1b2c3.js')}`;
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'did not store the release object under its own key',
    );
  });

  test('accepts a store that reports the key verbatim', async () => {
    await expect(
      publishRelease({appRoot, store, yes: true}),
    ).resolves.toMatchObject({dryRun: false});
  });

  test('rejects a mobile manifest without writes', async () => {
    writeManifest({target: 'capacitor', publishable: false});
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'Only publishable web release manifests',
    );
    expect(store.writes).toHaveLength(0);
  });

  test('rejects a destination whose accessURL no longer matches', async () => {
    const other = new MemoryFileStore('https://other-cdn.example.test');
    await expect(
      publishRelease({appRoot, store: other, yes: true}),
    ).rejects.toThrow('Release destination does not match the manifest');
    expect(other.writes).toHaveLength(0);
  });

  test('accepts an accessURL that differs only by a trailing slash', async () => {
    const trailing = new MemoryFileStore(`${ACCESS_URL}/`);
    await expect(
      publishRelease({appRoot, store: trailing, yes: true}),
    ).resolves.toMatchObject({dryRun: false});
  });

  test('rejects a changed local file before any write', async () => {
    fs.writeFileSync(
      path.join(appRoot, 'public/bundles/a.12345678.js'),
      'changed',
    );
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'changed after build',
    );
    expect(store.writes).toHaveLength(0);
  });

  test('does not upload the release manifest after a partial failure', async () => {
    store.failKey = `${PREFIX}/public/bundles/b.12345678.css`;
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'Release upload failed',
    );
    expect(store.writes.map((write) => write.key)).toEqual([
      `${PREFIX}/public/bundles/a.12345678.js`,
    ]);
  });

  test('a mid-upload failure says what failed, where, and how to recover', async () => {
    store.failKey = `${PREFIX}/public/bundles/b.12345678.css`;
    const failure = await publishRelease({appRoot, store, yes: true}).catch(
      (error: Error) => error,
    );
    const message = failure.message;
    // The file and the key it was going to.
    expect(message).toContain('public/bundles/b.12345678.css');
    expect(message).toContain(`"${PREFIX}/public/bundles/b.12345678.css"`);
    // Where it was going, and how far the release got.
    expect(message).toContain(ACCESS_URL);
    expect(message).toContain('1 of 3 objects were already uploaded');
    expect(message).toContain(`"${PREFIX}"`);
    expect(message).toContain('the release manifest was not uploaded');
    expect(message).toContain('Re-running publish-app resumes it');
    // ...and the underlying store error is still in there.
    expect(message).toContain('failed releases/');
  });

  describe('a manifest may only upload to its own release prefix', () => {
    const hostileFile = (overrides: Record<string, unknown>) => ({
      sourcePath: 'public/bundles/a.12345678.js',
      objectKey: `${PREFIX}/public/bundles/a.12345678.js`,
      sha256: sha('aaa'),
      size: 3,
      contentType: 'text/javascript',
      cacheControl: 'public, max-age=31536000, immutable',
      ...overrides,
    });

    test('rejects an object key outside the release prefix', async () => {
      // Shape-valid, but it would overwrite a different, already-live release.
      writeManifest({
        files: [
          hostileFile({
            objectKey: 'releases/4.2.5-other/public/bundles/a.12345678.js',
          }),
        ],
      });
      await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
        'not under the release prefix',
      );
      expect(store.writes).toHaveLength(0);
    });

    test('rejects an object key that climbs out with ..', async () => {
      writeManifest({
        files: [hostileFile({objectKey: `${PREFIX}/../../evil/a.js`})],
      });
      await expect(
        publishRelease({appRoot, store, yes: true}),
      ).rejects.toThrow();
      expect(store.writes).toHaveLength(0);
    });

    test('rejects a source path that climbs out of the app root', async () => {
      writeManifest({
        files: [
          hostileFile({
            sourcePath: '../../../etc/passwd',
            objectKey: `${PREFIX}/etc/passwd`,
          }),
        ],
      });
      await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
        'must stay inside the application root',
      );
      expect(store.writes).toHaveLength(0);
    });

    test('rejects an absolute source path', async () => {
      writeManifest({
        files: [
          hostileFile({
            sourcePath: '/etc/passwd',
            objectKey: `${PREFIX}/etc/passwd`,
          }),
        ],
      });
      await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
        'must be relative',
      );
      expect(store.writes).toHaveLength(0);
    });

    test('rejects a source path that leaves the app root through a symlink', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-outside-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'aaa');
      fs.symlinkSync(outside, path.join(appRoot, 'public/escape'));
      writeManifest({
        files: [
          hostileFile({
            sourcePath: 'public/escape/secret.txt',
            objectKey: `${PREFIX}/public/escape/secret.txt`,
          }),
        ],
      });
      try {
        await expect(
          publishRelease({appRoot, store, yes: true}),
        ).rejects.toThrow('escapes the application root');
        expect(store.writes).toHaveLength(0);
      } finally {
        fs.rmSync(outside, {recursive: true, force: true});
      }
    });
  });

  test('fails when the uploaded hash does not match', async () => {
    store.statFile = async (filePath: string) => ({
      size: store.writes.find((write) => write.key === filePath)!.body
        .byteLength,
      sha256: sha('something else'),
    });
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'verification failed',
    );
  });

  test('fails when the uploaded size does not match', async () => {
    store.sizeOverride = 999;
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'size does not match',
    );
  });

  test('fails when an uploaded object is missing from the store', async () => {
    store.statFile = async () => null;
    await expect(publishRelease({appRoot, store, yes: true})).rejects.toThrow(
      'missing from the store',
    );
  });

  test('skips verification and warns once when the store has no statFile', async () => {
    delete (store as Partial<MemoryFileStore>).statFile;
    const warnings: string[] = [];
    const result = await publishRelease({
      appRoot,
      store,
      yes: true,
      onWarning: (message) => warnings.push(message),
    });
    expect(result.dryRun).toBe(false);
    expect(store.writes).toHaveLength(3);
    expect(result.unverified).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('does not implement statFile');
  });

  test('skips verification and warns once when the store reports no sha256', async () => {
    store.reportsHash = false;
    const warnings: string[] = [];
    const result = await publishRelease({
      appRoot,
      store,
      yes: true,
      onWarning: (message) => warnings.push(message),
    });
    expect(store.writes).toHaveLength(3);
    expect(result.unverified).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('no sha256');
  });

  test('never treats an etag as a content hash', async () => {
    store.reportsHash = false;
    const result = await publishRelease({appRoot, store, yes: true});
    // Every object carried an etag, yet none of them counted as verified.
    expect(result.unverified).toHaveLength(3);
  });

  test('publish-app reads the manifest before it resolves a store', async () => {
    // A Capacitor app has no appAssets store; resolving one first turned an
    // unpublishable manifest into a confusing storage-configuration error.
    writeManifest({target: 'capacitor', publishable: false});
    const resolveStore = jest.fn(async () => {
      throw new Error('No file store configured for purpose appAssets');
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(publishApp({appRoot, resolveStore, yes: true})).rejects.toThrow(
        'Only publishable web release manifests',
      );
      expect(resolveStore).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test('publish-app resolves the store lazily for a valid manifest', async () => {
    const resolveStore = jest.fn(async () => store as IFileStore);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await publishApp({appRoot, resolveStore, yes: true});
      expect(result.dryRun).toBe(false);
      expect(resolveStore).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test('redacts configured credentials from upload errors', async () => {
    const secret = 'super-secret-value';
    process.env.STATIC_AWS_SECRET_ACCESS_KEY = secret;
    store.saveFile = async () => {
      throw new Error(`provider rejected ${secret}`);
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const failure = await publishApp({appRoot, store, yes: true}).catch(
        (error: Error) => error,
      );
      expect(failure.message).toContain('provider rejected [REDACTED]');
      expect(failure.message).not.toContain(secret);
      expect(failure.stack).toContain('publisher.test.ts');
      expect(failure.stack).not.toContain(secret);
    } finally {
      delete process.env.STATIC_AWS_SECRET_ACCESS_KEY;
      log.mockRestore();
    }
  });
});
