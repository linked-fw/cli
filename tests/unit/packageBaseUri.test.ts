import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  normalizeBaseUri,
  resolvePackageBaseUri,
  withBaseUri,
} from '../../src/utils/packageBaseUri';

// A package created inside an app gets the app's root: --base-uri, then
// LINKED_BASE_URI from the shell, then the app's .env.local, then its .env.

describe('resolvePackageBaseUri', () => {
  let app: string;

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-base-uri-'));
  });

  afterEach(() => {
    fs.rmSync(app, {recursive: true, force: true});
  });

  const resolve = (flag?: string, env: NodeJS.ProcessEnv = {}, appRoot: string | null = app) =>
    resolvePackageBaseUri({flag, appRoot, env});

  it('is undefined when nothing sets it', () => {
    expect(resolve()).toBeUndefined();
    fs.writeFileSync(path.join(app, '.env'), 'APP_NAME=x\nLINKED_BASE_URI=\n');
    expect(resolve()).toBeUndefined();
  });

  it('reads .env, and .env.local over it', () => {
    fs.writeFileSync(path.join(app, '.env'), 'LINKED_BASE_URI=https://env.example.org\n');
    expect(resolve()).toEqual({baseUri: 'https://env.example.org/', source: '.env'});
    fs.writeFileSync(path.join(app, '.env.local'), 'LINKED_BASE_URI="https://local.example.org/"\n');
    expect(resolve()).toEqual({baseUri: 'https://local.example.org/', source: '.env.local'});
  });

  it('lets the shell win over the files, and the flag win over everything', () => {
    fs.writeFileSync(path.join(app, '.env'), 'LINKED_BASE_URI=https://env.example.org/\n');
    const env = {LINKED_BASE_URI: 'https://shell.example.org/'};
    expect(resolve(undefined, env)).toEqual({
      baseUri: 'https://shell.example.org/',
      source: 'environment',
    });
    expect(resolve('https://acme.id.create.now', env)).toEqual({
      baseUri: 'https://acme.id.create.now/',
      source: '--base-uri',
    });
  });

  it('outside an app only the flag counts', () => {
    const env = {LINKED_BASE_URI: 'https://shell.example.org/'};
    expect(resolve(undefined, env, null)).toBeUndefined();
    expect(resolve('https://acme.example.org/', env, null)?.baseUri).toBe(
      'https://acme.example.org/',
    );
  });

  it('refuses a value that is not an absolute http(s) root', () => {
    for (const bad of ['acme', 'ftp://example.org/', 'https://example.org/?q', 'https://example.org/#x']) {
      expect(() => normalizeBaseUri(bad, '--base-uri')).toThrow(/--base-uri must be an absolute/);
    }
    fs.writeFileSync(path.join(app, '.env'), 'LINKED_BASE_URI=not-a-uri\n');
    expect(() => resolve()).toThrow(/LINKED_BASE_URI in .*\.env must be an absolute/);
  });
});

describe('withBaseUri', () => {
  it('adds the root to the linkedPackage call', () => {
    expect(withBaseUri(`} = linkedPackage('foo-assets');`, 'https://acme.id.create.now/')).toBe(
      `} = linkedPackage('foo-assets', {baseUri: "https://acme.id.create.now/"});`,
    );
  });

  it('throws when there is no call to rewrite', () => {
    expect(() => withBaseUri('export {};', 'https://a.example/')).toThrow(/no linkedPackage/);
  });
});
