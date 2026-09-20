import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  joinObjectKey,
  joinStaticAssetUrl,
  normalizeReleasePath,
  resolveExistingPathWithinRoot,
} from '../../src/app-release/paths.js';

describe('release paths', () => {
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-release-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  });

  test('normalizes Windows and POSIX separators', () => {
    expect(normalizeReleasePath('public\\bundles/chunk.js')).toBe(
      'public/bundles/chunk.js',
    );
    expect(joinObjectKey('v4.2.6/', '/public\\bundles/app.js')).toBe(
      'v4.2.6/public/bundles/app.js',
    );
  });

  test.each(['/absolute/file.js', 'C:\\absolute\\file.js', '../escape.js'])(
    'rejects unsafe path %p',
    (unsafePath) => {
      expect(() => normalizeReleasePath(unsafePath)).toThrow();
    },
  );

  test('rejects a symlink that escapes the application root', () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-outside-'));
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    fs.writeFileSync(outsideFile, 'not a release artifact');
    fs.symlinkSync(outsideFile, path.join(temporaryRoot, 'escaped.txt'));

    expect(() =>
      resolveExistingPathWithinRoot(temporaryRoot, 'escaped.txt'),
    ).toThrow('source path escapes the application root');

    fs.rmSync(outsideRoot, {recursive: true, force: true});
  });

  test('resolves an existing file inside the application root', () => {
    fs.mkdirSync(path.join(temporaryRoot, 'public'));
    const filePath = path.join(temporaryRoot, 'public', 'app.js');
    fs.writeFileSync(filePath, 'console.log("ok")');

    expect(resolveExistingPathWithinRoot(temporaryRoot, 'public/app.js')).toBe(
      fs.realpathSync(filePath),
    );
  });

  test('joins a versioned static asset URL', () => {
    expect(
      joinStaticAssetUrl(
        'https://cdn.example/v4.2.6',
        'public/bundles/a.js',
      ),
    ).toBe('https://cdn.example/v4.2.6/public/bundles/a.js');
  });

  test('does not create duplicate URL separators', () => {
    expect(
      joinStaticAssetUrl(
        'https://cdn.example/v4.2.6/',
        './public/bundles/a.js',
      ),
    ).toBe('https://cdn.example/v4.2.6/public/bundles/a.js');
  });
});
