import fs from 'fs';
import os from 'os';
import path from 'path';
import {resolveDeclaredStaticAssets} from '../../src/app-release/static-assets.js';

describe('resolveDeclaredStaticAssets', () => {
  let appRoot: string;

  const write = (relativePath: string, content: string) => {
    const absolutePath = path.join(appRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
    fs.writeFileSync(absolutePath, content);
  };

  beforeEach(() => {
    appRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-static-')),
    );
    write('public/favicon.ico', 'icon');
    write('public/images/hero.svg', '<svg/>');
    write('secret/credentials.json', '{"token":"nope"}');
    write('lib/backend.js', 'backend');
  });

  afterEach(() => fs.rmSync(appRoot, {recursive: true, force: true}));

  test('collects files under public/', () => {
    expect(
      resolveDeclaredStaticAssets(appRoot, ['public/favicon*', 'public/images/**']),
    ).toEqual(['public/favicon.ico', 'public/images/hero.svg']);
  });

  test('no declared patterns collects nothing', () => {
    expect(resolveDeclaredStaticAssets(appRoot, [])).toEqual([]);
  });

  test('brace expansion cannot escape public/', () => {
    // The pattern passes a prefix test on its own text, but glob expands the
    // brace to `public/../secret/**` and returns matches as plain `secret/…`.
    expect(() =>
      resolveDeclaredStaticAssets(appRoot, ['public/{,../}secret/**']),
    ).toThrow('resolves outside public/');
  });

  test('a sibling directory of public/ is refused', () => {
    expect(() => resolveDeclaredStaticAssets(appRoot, ['lib/**'])).toThrow(
      'must stay inside public/',
    );
  });

  test('a pattern that leaves the app root is refused', () => {
    expect(() => resolveDeclaredStaticAssets(appRoot, ['../../etc/*'])).toThrow(
      'must stay inside the application root',
    );
  });

  test('a symlink under public/ that points outside it is refused', () => {
    fs.symlinkSync(
      path.join(appRoot, 'secret'),
      path.join(appRoot, 'public/linked-secret'),
    );
    expect(() =>
      resolveDeclaredStaticAssets(appRoot, ['public/linked-secret/**']),
    ).toThrow(/resolves outside public\/|must stay inside/);
  });
});
