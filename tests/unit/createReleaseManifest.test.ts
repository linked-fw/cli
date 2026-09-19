import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ENTRY_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  createReleaseManifest,
  getCacheControl,
  serializeReleaseManifest,
} from '../../src/app-release/create-release-manifest.js';

const PREFIX = 'releases/4.2.6-abc123def456';
const key = (sourcePath: string) => `${PREFIX}/${sourcePath}`;

describe('createReleaseManifest', () => {
  let appRoot: string;

  const write = (relativePath: string, content: string) => {
    const absolutePath = path.join(appRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
    fs.writeFileSync(absolutePath, content);
  };

  const create = (overrides: Record<string, unknown> = {}) =>
    createReleaseManifest({
      appRoot,
      environmentNames: ['cn-staging'],
      target: 'web',
      accessURL: 'https://cdn.example.test',
      builtAt: '2026-09-17T00:00:00.000Z',
      sourceRevision: 'abc123def456',
      ...overrides,
    });

  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-manifest-'));
    write('package.json', JSON.stringify({name: 'peacegame', version: '4.2.6'}));
    write('public/bundles/assets/main.12345678.js', 'main');
    write('public/bundles/assets/main.12345678.css', 'css');
    write('public/bundles/assets/lazy.abcdef12.js', 'lazy');
    write('public/bundles/assets/logo.87654321.png', 'png');
    write(
      'public/bundles/.vite/manifest.json',
      JSON.stringify({
        'src/index.tsx': {
          file: 'assets/main.12345678.js',
          css: ['assets/main.12345678.css'],
          assets: ['assets/logo.87654321.png'],
          dynamicImports: ['src/lazy.tsx'],
        },
        'src/lazy.tsx': {file: 'assets/lazy.abcdef12.js'},
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(appRoot, {recursive: true, force: true});
  });

  test('collects the complete Vite output graph exactly once', () => {
    const manifest = create();
    expect(manifest.files.map((file) => file.objectKey)).toEqual([
      key('public/bundles/assets/lazy.abcdef12.js'),
      key('public/bundles/assets/logo.87654321.png'),
      key('public/bundles/assets/main.12345678.css'),
      key('public/bundles/assets/main.12345678.js'),
    ]);
  });

  test('nests every object under a per-release prefix', () => {
    const manifest = create();
    expect(manifest.destination.releasePrefix).toBe(PREFIX);
    expect(manifest.releaseId).toBe('4.2.6-abc123def456');
    for (const file of manifest.files) {
      expect(file.objectKey).toBe(`${PREFIX}/${file.sourcePath}`);
    }
  });

  test('a different revision produces a disjoint set of object keys', () => {
    const first = create();
    const second = create({sourceRevision: 'fedcba987654'});
    const firstKeys = new Set(first.files.map((file) => file.objectKey));
    for (const file of second.files) {
      expect(firstKeys.has(file.objectKey)).toBe(false);
    }
    expect(second.destination.releasePrefix).toBe('releases/4.2.6-fedcba987654');
  });

  test('honours a configured release prefix base', () => {
    const manifest = create({releasePrefix: 'cdn/app'});
    expect(manifest.destination.releasePrefix).toBe(
      'cdn/app/4.2.6-abc123def456',
    );
    expect(manifest.files[0].objectKey.startsWith('cdn/app/4.2.6-')).toBe(true);
  });

  test('records the store accessURL as the destination', () => {
    expect(create().destination.accessURL).toBe('https://cdn.example.test');
  });

  test('includes only declared extra static assets', () => {
    write('public/favicon.ico', 'icon');
    write('public/images/hero.svg', '<svg/>');
    write('public/private.txt', 'exclude');
    const manifest = create({
      staticAssets: ['public/favicon*', 'public/images/**'],
    });
    const keys = manifest.files.map((file) => file.objectKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        key('public/favicon.ico'),
        key('public/images/hero.svg'),
      ]),
    );
    expect(keys).not.toContain(key('public/private.txt'));
  });

  test('fails when an emitted Vite file is missing', () => {
    fs.rmSync(path.join(appRoot, 'public/bundles/assets/main.12345678.js'));
    expect(() => create()).toThrow(/main\.12345678\.js/);
  });

  test('serializes deterministically for identical build inputs', () => {
    expect(serializeReleaseManifest(create())).toBe(
      serializeReleaseManifest(create()),
    );
  });

  test('records content metadata and immutable cache policy', () => {
    const manifest = create();
    const lazy = manifest.files.find((file) =>
      file.objectKey.endsWith('lazy.abcdef12.js'),
    )!;
    expect(lazy.sha256).toBe(
      crypto.createHash('sha256').update('lazy').digest('hex'),
    );
    expect(lazy.size).toBe(4);
    expect(lazy.contentType).toBe('text/javascript; charset=utf-8');
    expect(lazy.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  test('gives unhashed entry files a short cache policy', () => {
    write('public/index.html', '<html></html>');
    const manifest = create({staticAssets: ['public/index.html']});
    const entry = manifest.files.find((file) =>
      file.objectKey.endsWith('index.html'),
    )!;
    expect(entry.cacheControl).toBe(ENTRY_CACHE_CONTROL);
  });

  test.each([
    // Vite's default names are base64url, not hex.
    ['main-hwqwrAvA.css', IMMUTABLE_CACHE_CONTROL],
    ['main-BZAFw2tv.js', IMMUTABLE_CACHE_CONTROL],
    ['main.12345678.js', IMMUTABLE_CACHE_CONTROL],
    ['logo.87654321.png', IMMUTABLE_CACHE_CONTROL],
    ['index.html', ENTRY_CACHE_CONTROL],
    ['linked-release.json', ENTRY_CACHE_CONTROL],
    ['service-worker.js', ENTRY_CACHE_CONTROL],
    ['main.js', ENTRY_CACHE_CONTROL],
  ])('cache policy for %s', (fileName, expected) => {
    expect(getCacheControl(`public/bundles/${fileName}`)).toBe(expected);
  });

  test('deduplicates files referenced by multiple entries', () => {
    const vitePath = path.join(appRoot, 'public/bundles/.vite/manifest.json');
    const viteManifest = JSON.parse(fs.readFileSync(vitePath, 'utf8'));
    viteManifest['src/other.tsx'] = {file: 'assets/lazy.abcdef12.js'};
    fs.writeFileSync(vitePath, JSON.stringify(viteManifest));
    const manifest = create();
    expect(
      manifest.files.filter((file) =>
        file.objectKey.endsWith('lazy.abcdef12.js'),
      ),
    ).toHaveLength(1);
  });

  test('builds a local, non-publishable Capacitor manifest without a store', () => {
    const manifest = create({target: 'capacitor', accessURL: null});
    expect(manifest.publishable).toBe(false);
    expect(manifest.target).toBe('capacitor');
    expect(manifest.destination.accessURL).toBe('');
    expect(manifest.destination.releasePrefix).toBe(PREFIX);
    // No Vite manifest is read for a native build, so it lists no bundles.
    expect(manifest.files).toEqual([]);
  });

  test('refuses a web manifest with no destination accessURL', () => {
    expect(() => create({accessURL: undefined})).toThrow(
      'requires the accessURL',
    );
  });

  test('excludes stale files not referenced by Vite', () => {
    write('public/bundles/assets/stale.11111111.js', 'stale');
    expect(create().files.map((file) => file.objectKey)).not.toContain(
      key('public/bundles/assets/stale.11111111.js'),
    );
  });

  test('rejects a Vite import that is absent from its manifest', () => {
    const vitePath = path.join(appRoot, 'public/bundles/.vite/manifest.json');
    const viteManifest = JSON.parse(fs.readFileSync(vitePath, 'utf8'));
    viteManifest['src/index.tsx'].imports = ['src/missing.ts'];
    fs.writeFileSync(vitePath, JSON.stringify(viteManifest));
    expect(() => create()).toThrow('references missing import src/missing.ts');
  });
});
