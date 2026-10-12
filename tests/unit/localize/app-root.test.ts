/**
 * `findAppRoot`: the topmost directory whose package.json has `workspaces`
 * (preferring one that is not a linked package), else where the command ran.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {findAppRoot, findWorkspaceRoot} from '../../../src/localize/app-root.js';
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
  assert.equal(findAppRoot(path.join(member, 'src')), app, 'any directory below it');
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
