/**
 * `findAppRoot`: the nearest directory whose package.json has `workspaces`,
 * then up through each ancestor whose globs match it (preferring one that is
 * not a linked package), else where the command ran.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  findAppRoot,
  findWorkspaceRoot,
} from '../../../src/localize/app-root.js';
import {rm, test, tmpdir} from './helpers.js';

function write(dir: string, pkg: object | string) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    typeof pkg === 'string' ? pkg : JSON.stringify(pkg),
  );
}

test('from a workspace member, the app above it', (t) => {
  const app = tmpdir('localize-app-root-');
  t.after(() => rm(app));
  write(app, {name: 'app', workspaces: ['packages/*']});
  const member = path.join(app, 'packages', 'foo');
  write(member, {name: 'foo'});
  assert.equal(findAppRoot(member), app);
  assert.equal(
    findAppRoot(path.join(member, 'src')),
    app,
    'any directory below it',
  );
  assert.equal(findAppRoot(app), app);
});

test('the topmost one, preferring an app over a linked package with workspaces', (t) => {
  const top = tmpdir('localize-app-root-');
  t.after(() => rm(top));
  write(top, {name: 'app', workspaces: ['packages-local/*']});
  const inner = path.join(top, 'packages-local', 'mono');
  write(inner, {name: 'mono', workspaces: ['packages/*']});
  assert.equal(findAppRoot(inner), top);

  write(top, {name: 'lib', linkedPackage: true, workspaces: ['x/*']});
  const app = path.join(top, 'x', 'app');
  write(app, {name: 'app', workspaces: ['packages/*']});
  assert.equal(findAppRoot(app), app);
});

test('no workspaces anywhere: where it ran (an app before its set-up); unreadable files are skipped', (t) => {
  const app = tmpdir('localize-app-root-');
  t.after(() => rm(app));
  write(app, {name: 'app'});
  write(path.join(app, 'broken'), '{not json');
  assert.equal(findWorkspaceRoot(app), null);
  assert.equal(findAppRoot(app), app);
  assert.equal(findAppRoot(path.join(app, 'broken')), path.join(app, 'broken'));
});

test('a git worktree nested in the app, which no app glob matches, is its own app', (t) => {
  const app = tmpdir('localize-app-root-');
  t.after(() => rm(app));
  write(app, {name: 'app', workspaces: ['packages/*', 'packages-local/*']});
  const wt = path.join(app, '.claude', 'worktrees', 'wt');
  write(wt, {name: 'app', workspaces: ['packages/*', 'packages-local/*']});
  const member = path.join(wt, 'packages', 'foo');
  write(member, {name: 'foo'});
  assert.equal(findAppRoot(wt), wt);
  assert.equal(findAppRoot(member), wt, 'a member of the worktree');
  assert.equal(findAppRoot(path.join(app, 'packages', 'bar')), app);
});

test('the climb stops at the first ancestor whose globs do not match, and honours negations', (t) => {
  const top = tmpdir('localize-app-root-');
  t.after(() => rm(top));
  write(top, {name: 'top', workspaces: ['apps/*', '!apps/skip']});
  for (const name of ['web', 'skip']) {
    write(path.join(top, 'apps', name), {name, workspaces: ['packages/*']});
  }
  assert.equal(findAppRoot(path.join(top, 'apps', 'web')), top);
  assert.equal(
    findAppRoot(path.join(top, 'apps', 'skip')),
    path.join(top, 'apps', 'skip'),
  );
  write(path.join(top, 'deep', 'a', 'b'), {name: 'b', workspaces: ['x/*']});
  write(top, {name: 'top', workspaces: ['deep/**']});
  assert.equal(
    findAppRoot(path.join(top, 'deep', 'a', 'b')),
    top,
    '** across depth',
  );
});

test('from inside a --subdir checkout (its real path under packages-local/.repos), the app', (t) => {
  const app = tmpdir('localize-app-root-');
  t.after(() => rm(app));
  write(app, {name: 'app', workspaces: ['packages/*', 'packages-local/*']});
  const mono = path.join(app, 'packages-local', '.repos', 'mono');
  write(mono, {name: 'mono', private: true, workspaces: ['packages/*']});
  write(path.join(mono, 'packages', 'foo'), {name: '@x/foo'});
  const link = path.join(app, 'packages-local', 'x-foo');
  fs.symlinkSync(path.join('.repos', 'mono', 'packages', 'foo'), link);
  assert.equal(findAppRoot(fs.realpathSync(link)), app);
  assert.equal(findAppRoot(mono), app, 'from the monorepo root');
  const aside = path.join(app, 'packages-local', '.setup-aside', 'bar');
  write(aside, {name: 'bar', workspaces: ['packages/*']});
  assert.equal(findAppRoot(aside), app, 'from a checkout set aside');

  write(app, {name: 'app', workspaces: ['packages/*']});
  assert.equal(
    findAppRoot(mono),
    mono,
    'not when the app does not list packages-local/*',
  );
});
