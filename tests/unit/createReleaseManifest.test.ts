import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createReleaseManifest,
  serializeReleaseManifest,
} from '../../src/app-release/create-release-manifest.js';

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
      destination: {
        bucket: 'pg-cn-staging',
        destinationPrefix: '4.2.6',
        publicBaseUrl: 'https://pg-cn-staging.example',
      },
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
    write('public/bundles/.vite/manifest.json', JSON.stringify({
      'src/index.tsx': {
        file: 'assets/main.12345678.js',
        css: ['assets/main.12345678.css'],
        assets: ['assets/logo.87654321.png'],
        dynamicImports: ['src/lazy.tsx'],
      },
      'src/lazy.tsx': {file: 'assets/lazy.abcdef12.js'},
    }));
  });

  afterEach(() => {
    fs.rmSync(appRoot, {recursive: true, force: true});
  });

  test('collects the complete Vite output graph exactly once', () => {
    const manifest = create();
    expect(manifest.files.map((file) => file.objectKey)).toEqual([
      'public/bundles/assets/lazy.abcdef12.js',
      'public/bundles/assets/logo.87654321.png',
      'public/bundles/assets/main.12345678.css',
      'public/bundles/assets/main.12345678.js',
    ]);
  });

  test('includes only declared extra static assets', () => {
    write('public/favicon.ico', 'icon');
    write('public/images/hero.svg', '<svg/>');
    write('public/private.txt', 'exclude');
    const manifest = create({
      staticAssets: ['public/favicon*', 'public/images/**'],
    });
    expect(manifest.files.map((file) => file.objectKey)).toEqual(
      expect.arrayContaining(['public/favicon.ico', 'public/images/hero.svg']),
    );
    expect(manifest.files.map((file) => file.objectKey)).not.toContain(
      'public/private.txt',
    );
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
    const main = manifest.files.find((file) => file.objectKey.endsWith('.js'))!;
    expect(main.sha256).toBe(
      crypto.createHash('sha256').update('lazy').digest('hex'),
    );
    expect(main.size).toBe(4);
    expect(main.contentType).toBe('text/javascript; charset=utf-8');
    expect(main.cacheControl).toBe('public, max-age=31536000, immutable');
  });

  test('deduplicates files referenced by multiple entries', () => {
    const vitePath = path.join(appRoot, 'public/bundles/.vite/manifest.json');
    const viteManifest = JSON.parse(fs.readFileSync(vitePath, 'utf8'));
    viteManifest['src/other.tsx'] = {file: 'assets/lazy.abcdef12.js'};
    fs.writeFileSync(vitePath, JSON.stringify(viteManifest));
    const manifest = create();
    expect(
      manifest.files.filter((file) => file.objectKey.endsWith('lazy.abcdef12.js')),
    ).toHaveLength(1);
  });

  test('marks a Capacitor manifest as non-publishable', () => {
    const manifest = create({target: 'capacitor'});
    expect(manifest.publishable).toBe(false);
    expect(manifest.target).toBe('capacitor');
  });

  test('excludes stale files not referenced by Vite', () => {
    write('public/bundles/assets/stale.11111111.js', 'stale');
    expect(create().files.map((file) => file.objectKey)).not.toContain(
      'public/bundles/assets/stale.11111111.js',
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
