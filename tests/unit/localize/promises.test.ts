/**
 * The two promises localize makes to the consumer, tested as promises rather
 * than as implementation:
 *
 *   1. it never changes package.json or package-lock.json, and says so loudly
 *      if something else did while it ran;
 *   2. the command line stays quiet where it has nothing to say.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {runLocalize} from '../../../src/commands/localize.js';
import {localize} from '../../../src/localize/localize.js';
import {makeConsumer, ok, rm, stubbed, test} from './helpers.js';

const consumer = (t, pkg) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

test('a manifest changed during the run is exit 8, even when the work succeeded', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(
        path.join(dest, 'package.json'),
        JSON.stringify({name: 'widget', version: '1.0.0'}),
      );
      return ok();
    }
    if (inv.cmd === 'npm' && inv.args[0] === 'install') {
      // Stand in for a "simplification" that let npm near the consumer root.
      fs.writeFileSync(
        path.join(appRoot, 'package-lock.json'),
        '{"lockfileVersion":3}\n',
      );
      return ok();
    }
    if (inv.args[0] === 'rev-parse') return ok('main\n');
    return ok();
  });

  assert.equal(localize(['widget'], {repo: 'r'}, deps), 8);
  assert.match(deps.output(), /package-lock\.json \(created\)/);
  assert.match(deps.output(), /the exact failure localize exists to prevent/);
});

test('an uncommitted package.json is NOT a failure', (t) => {
  // The check compares content hashes taken when the command started, not
  // `git status` against HEAD. An earlier tool compared against HEAD and so
  // reported every correct run as a failure in any tree with an uncommitted
  // package.json -- which, in a repo where localize is part of the loop, is
  // most of them.
  const appRoot = consumer(t);
  execFileSync('git', ['init', '-q'], {cwd: appRoot});
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(
        path.join(dest, 'package.json'),
        JSON.stringify({name: 'widget', version: '1.0.0'}),
      );
      return ok();
    }
    if (inv.args[0] === 'rev-parse') return ok('main\n');
    return ok();
  });
  assert.equal(localize(['widget'], {repo: 'r'}, deps), 0, deps.output());
});

// The retired `linked-localize` bin had its own parser, so its suite asserted
// `--help`, `--version` and the rejection of an unknown option. `linked
// localize` is a commander command: those are commander's (and
// unknownCommand.test.ts's). What carries over is how the command behaves in a
// tree with nothing localized, asserted through the entry `linked localize`
// runs.

/** Run `linked localize` in `appRoot`, capturing what it prints. */
async function linkedLocalize(appRoot, options) {
  const out = [];
  const spies = ['log', 'warn', 'error'].map((m) =>
    jest.spyOn(console, m as 'log').mockImplementation((...a) => {
      out.push(a.join(' '));
    }),
  );
  const cwd = process.cwd();
  process.chdir(appRoot);
  try {
    await runLocalize([], options);
    return {out: out.join('\n'), code: process.exitCode};
  } finally {
    process.chdir(cwd);
    spies.forEach((s) => s.mockRestore());
    process.exitCode = undefined;
  }
}

test('the CLI in a tree with nothing localized is silent and exits 0', async (t) => {
  const appRoot = consumer(t);
  const {out, code} = await linkedLocalize(appRoot, {list: true});
  assert.equal(out, '');
  assert.equal(code, 0);
});

test('`linked localize --relink` from a postinstall is a no-op with no manifest', async (t) => {
  const appRoot = consumer(t);
  const {out, code} = await linkedLocalize(appRoot, {relink: true});
  assert.equal(out, '');
  assert.equal(code, 0);
  assert.equal(
    fs.existsSync(path.join(appRoot, 'local-packages.json')),
    false,
    'it did not create one',
  );
});
