import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {resolveSourceRevision} from '../../src/app-release/create-release-manifest.js';

const git = (appRoot: string, ...args: string[]) =>
  execFileSync('git', args, {cwd: appRoot, encoding: 'utf8'}).trim();

describe('resolveSourceRevision', () => {
  let appRoot: string;

  const head = () => git(appRoot, 'rev-parse', '--short=12', 'HEAD');

  beforeEach(() => {
    appRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-revision-')),
    );
    git(appRoot, 'init', '-q', '-b', 'main');
    git(appRoot, 'config', 'user.email', 'test@example.test');
    git(appRoot, 'config', 'user.name', 'Test');
    git(appRoot, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(appRoot, 'app.js'), 'committed');
    git(appRoot, 'add', '.');
    git(appRoot, 'commit', '-q', '-m', 'initial');
  });

  afterEach(() => fs.rmSync(appRoot, {recursive: true, force: true}));

  test('uses the short HEAD of a clean tree', () => {
    expect(resolveSourceRevision({appRoot, env: {}})).toBe(head());
  });

  test('refuses a tree with uncommitted changes', () => {
    fs.writeFileSync(path.join(appRoot, 'app.js'), 'edited');
    expect(() => resolveSourceRevision({appRoot, env: {}})).toThrow(
      'uncommitted changes',
    );
  });

  test('refuses a tree with an untracked file', () => {
    fs.writeFileSync(path.join(appRoot, 'new.js'), 'new');
    expect(() => resolveSourceRevision({appRoot, env: {}})).toThrow(
      'uncommitted changes',
    );
  });

  test('--allow-dirty marks the revision instead of refusing', () => {
    fs.writeFileSync(path.join(appRoot, 'app.js'), 'edited');
    expect(resolveSourceRevision({appRoot, allowDirty: true, env: {}})).toBe(
      `${head()}-dirty`,
    );
  });

  test('an explicit revision wins and needs no clean tree', () => {
    fs.writeFileSync(path.join(appRoot, 'app.js'), 'edited');
    expect(
      resolveSourceRevision({appRoot, revision: 'deadbeef1234', env: {}}),
    ).toBe('deadbeef1234');
  });

  test('falls back to LINKED_RELEASE_REVISION, then GITHUB_SHA', () => {
    expect(
      resolveSourceRevision({
        appRoot,
        env: {LINKED_RELEASE_REVISION: 'from-linked', GITHUB_SHA: 'from-github'},
      }),
    ).toBe('from-linked');
    expect(resolveSourceRevision({appRoot, env: {GITHUB_SHA: 'from-github'}})).toBe(
      'from-github',
    );
  });

  test('rejects a revision that is not safe in an object key', () => {
    expect(() =>
      resolveSourceRevision({appRoot, revision: '../../etc', env: {}}),
    ).toThrow('Invalid release revision');
  });

  test('outside a Git checkout it names the escape hatch', () => {
    const notARepository = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-norepo-'));
    try {
      expect(() =>
        resolveSourceRevision({appRoot: notARepository, env: {}}),
      ).toThrow('--revision <sha>');
    } finally {
      fs.rmSync(notARepository, {recursive: true, force: true});
    }
  });
});
