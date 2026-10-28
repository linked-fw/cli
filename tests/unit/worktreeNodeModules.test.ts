/**
 * The node_modules link farm of an agent worktree: the plan (pure), the
 * overlays read from packages-local/, staleness and the doctor hints, the bin
 * modes, and the tsc flag for package builds inside a worktree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  farmStaleness,
  linkNodeModules,
  overlaysOf,
  planFarm,
  removeFarm,
  worktreeLinkHints,
  type SourceListing,
} from '../../src/commands/worktree-node-modules.js';
import {refuseSharedInstall} from '../../src/localize/localize.js';
import {insideSharedInstall, sharedInstall, tscFlagsFor} from '../../src/localize/shared-install.js';
import {binFiles, makeBinsExecutable} from '../../src/utils/bin-modes.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
});
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

const SRC = '/main/node_modules';
const listing: SourceListing = {
  top: [
    {name: 'react', dir: true},
    {name: '@radix-ui', dir: true},
    {name: '@_linked', dir: true},
    {name: '.bin', dir: true},
    {name: '.vite', dir: true},
    {name: '.cache', dir: true},
    {name: '.package-lock.json', dir: false},
    {name: '.yarn-integrity', dir: false},
  ],
  scopes: {
    '@_linked': [
      {name: 'core', dir: true, link: '../../packages-local/_linked-core'},
      {name: 'cli', dir: true, link: '../../packages-local/_linked-cli'},
    ],
  },
  bin: [
    {name: 'linked', dir: false, link: '../@_linked/cli/lib/esm/launch.js'},
    {name: 'abs', dir: false, link: '/opt/tool'},
    {name: 'shim.cmd', dir: false},
  ],
};

describe('planFarm', () => {
  test('links every entry to the main install, overlays to the worktree', () => {
    const ops = planFarm(SRC, listing, {'@_linked/cli': '/wt/packages-local/_linked-cli'});
    assert.deepEqual(ops, [
      {op: 'mkdir', path: '.bin'},
      {op: 'link', path: '.bin/abs', target: `${SRC}/.bin/abs`, dir: false},
      {op: 'relink', path: '.bin/linked', target: '../@_linked/cli/lib/esm/launch.js'},
      {op: 'copy', path: '.bin/shim.cmd', source: `${SRC}/.bin/shim.cmd`},
      {op: 'copy', path: '.yarn-integrity', source: `${SRC}/.yarn-integrity`},
      {op: 'mkdir', path: '@_linked'},
      {op: 'link', path: '@_linked/cli', target: '/wt/packages-local/_linked-cli', dir: true},
      {op: 'link', path: '@_linked/core', target: `${SRC}/@_linked/core`, dir: true},
      {op: 'link', path: '@radix-ui', target: `${SRC}/@radix-ui`, dir: true},
      {op: 'link', path: 'react', target: `${SRC}/react`, dir: true},
    ]);
  });

  test('a scope without an overlay is one link; caches and the hidden lockfile are left out', () => {
    const paths = planFarm(SRC, listing, {}).map((o) => o.path);
    assert.ok(paths.includes('@_linked'));
    assert.ok(!paths.some((p) => p.startsWith('@_linked/')));
    for (const skipped of ['.vite', '.cache', '.package-lock.json']) assert.ok(!paths.includes(skipped), skipped);
  });

  test('an overlay the main checkout never installed is still linked, scope and all', () => {
    const ops = planFarm(SRC, listing, {'@new/pkg': '/wt/packages-local/new-pkg', solo: '/wt/packages-local/solo'});
    assert.deepEqual(
      ops.filter((o) => o.path.startsWith('@new') || o.path === 'solo'),
      [
        {op: 'link', path: 'solo', target: '/wt/packages-local/solo', dir: true},
        {op: 'mkdir', path: '@new'},
        {op: 'link', path: '@new/pkg', target: '/wt/packages-local/new-pkg', dir: true},
      ],
    );
  });
});

/** A main checkout with an install, and a worktree with a checkout of `@x/a` in packages-local/. */
function layout(): {main: string; wt: string; checkout: string} {
  const main = tmp('farm-main-');
  const nm = path.join(main, 'node_modules');
  fs.mkdirSync(path.join(nm, 'dep'), {recursive: true});
  fs.mkdirSync(path.join(main, 'packages-local', 'x-a'), {recursive: true});
  fs.writeFileSync(path.join(main, 'packages-local', 'x-a', 'package.json'), '{"name":"@x/a"}');
  fs.mkdirSync(path.join(nm, '@x'));
  fs.symlinkSync('../../packages-local/x-a', path.join(nm, '@x', 'a'));
  const wt = tmp('farm-wt-');
  const checkout = path.join(wt, 'packages-local', 'x-a');
  fs.mkdirSync(path.join(checkout, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({name: '@x/a', bin: {xa: 'bin/xa.js'}}));
  fs.writeFileSync(path.join(checkout, 'bin', 'xa.js'), '#!/usr/bin/env node\n', {mode: 0o644});
  return {main, wt, checkout};
}

describe('linkNodeModules', () => {
  test('builds the farm; Node resolves the overlay to the worktree, the rest to the main install', () => {
    const {main, wt, checkout} = layout();
    assert.deepEqual(overlaysOf(wt), {'@x/a': checkout});
    const r = linkNodeModules(main, wt, overlaysOf(wt));
    assert.equal(r.replaced, 'nothing');
    assert.equal(fs.realpathSync(path.join(wt, 'node_modules', '@x', 'a')), checkout);
    assert.equal(fs.realpathSync(path.join(wt, 'node_modules', 'dep')), path.join(main, 'node_modules', 'dep'));
    assert.deepEqual(sharedInstall(wt), {layout: 'farm', installRoot: main});
    // The overlay's bin got the bit npm would have set.
    assert.equal(fs.statSync(path.join(checkout, 'bin', 'xa.js')).mode & 0o777, 0o755);
    assert.deepEqual(farmStaleness(wt), []);
    assert.deepEqual(worktreeLinkHints(wt), []);
  });

  test('a farm is stale once the main checkout installs more; removeFarm leaves the install alone', () => {
    const {main, wt} = layout();
    linkNodeModules(main, wt, overlaysOf(wt));
    fs.mkdirSync(path.join(main, 'node_modules', 'later'));
    assert.deepEqual(farmStaleness(wt), ['later']);
    assert.match(worktreeLinkHints(wt).join('\n'), /lacks later .*linked worktree relink/);
    assert.equal(removeFarm(wt), true);
    assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false);
    assert.ok(fs.existsSync(path.join(main, 'node_modules', 'dep')));
    assert.ok(fs.existsSync(path.join(main, 'packages-local', 'x-a', 'package.json')));
  });

  test('a symlinked node_modules with overlays gets the relink hint, and is replaced', () => {
    const {main, wt, checkout} = layout();
    fs.symlinkSync(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
    assert.match(worktreeLinkHints(wt).join('\n'), /tsc and Node load the main checkout's @x\/a/);
    assert.equal(linkNodeModules(main, wt, overlaysOf(wt)).replaced, 'symlink');
    assert.equal(fs.realpathSync(path.join(wt, 'node_modules', '@x', 'a')), checkout);
    // The main install's own link is as it was.
    assert.equal(fs.readlinkSync(path.join(main, 'node_modules', '@x', 'a')), '../../packages-local/x-a');
  });

  test('refuses to replace an install of the worktree its own', () => {
    const {main, wt} = layout();
    fs.mkdirSync(path.join(wt, 'node_modules', 'own'), {recursive: true});
    assert.throws(() => linkNodeModules(main, wt, {}), /install of the worktree's own/);
    assert.equal(removeFarm(wt), false);
    assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'own')));
  });

  test('localize refuses in a farm; a package build inside one preserves symlinks', () => {
    const {main, wt, checkout} = layout();
    linkNodeModules(main, wt, overlaysOf(wt));
    assert.throws(() => refuseSharedInstall(wt), new RegExp(`shares the install of ${main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(insideSharedInstall(checkout), true);
    assert.equal(tscFlagsFor(checkout), ' --preserveSymlinks');
    assert.equal(tscFlagsFor(path.join(main, 'packages-local', 'x-a')), '');
  });
});

describe('bin modes', () => {
  test('binFiles reads a string or an object', () => {
    assert.deepEqual(binFiles({bin: 'cli.js'}), ['cli.js']);
    assert.deepEqual(binFiles({bin: {a: 'a.js', b: 'b.js'}}), ['a.js', 'b.js']);
    assert.deepEqual(binFiles({}), []);
    assert.deepEqual(binFiles(null), []);
  });

  test('makeBinsExecutable adds x where r is set, once', () => {
    const {checkout} = layout();
    fs.chmodSync(path.join(checkout, 'bin', 'xa.js'), 0o640);
    assert.deepEqual(makeBinsExecutable(checkout), ['bin/xa.js']);
    assert.equal(fs.statSync(path.join(checkout, 'bin', 'xa.js')).mode & 0o777, 0o750);
    assert.deepEqual(makeBinsExecutable(checkout), []);
  });
});
