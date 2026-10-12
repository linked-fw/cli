/**
 * The drift report before `linked start`, `script`, `call` and `build-all`:
 * which commands trigger it, that it prints on stderr, and that it never
 * costs the command it precedes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';

import {
  DRIFT_COMMANDS,
  installDriftHook,
  reportDrift,
} from '../../../src/localize/drift-hook.js';
import {makeConsumer, rm, test} from './helpers.js';

function quietProgram(): Command {
  return new Command()
    .exitOverride()
    .configureOutput({writeOut: () => {}, writeErr: () => {}});
}

test('the report runs before exactly start, script, call and build-all', async () => {
  assert.deepEqual([...DRIFT_COMMANDS].sort(), [
    'build-all',
    'call',
    'script',
    'start',
  ]);
  const ran: string[] = [];
  const program = quietProgram();
  installDriftHook(program, () => ran.push('report'));
  const names = ['start', 'script', 'call', 'build-all', 'localize', 'build', 'publish'];
  for (const name of names) program.command(name).action(() => {});

  const triggered: string[] = [];
  for (const name of names) {
    ran.length = 0;
    await program.parseAsync(['node', 'linked', name]);
    if (ran.length) triggered.push(name);
  }
  ran.length = 0;
  for (const argv of [['help'], ['--help'], ['start', '--help']]) {
    try {
      await program.parseAsync(['node', 'linked', ...argv]);
    } catch {
      /* exitOverride: help "exits" */
    }
  }
  assert.deepEqual(triggered, ['start', 'script', 'call', 'build-all']);
  assert.equal(ran.length, 0, 'help never triggers it');

  // ...and the real program installs it, over commands with those names.
  const cli = fs.readFileSync(path.join(__dirname, '../../../src/cli.ts'), 'utf8');
  assert.match(cli, /^installDriftHook\(program\);$/m);
  for (const name of DRIFT_COMMANDS)
    assert.match(cli, new RegExp(`\\.command\\('${name}[ '\\]]`), name);
});

test('drift hook prints on stderr and never throws', async (t) => {
  const appRoot = makeConsumer({pkg: {dependencies: {'@x/a': '^2.0.0'}}});
  t.after(() => rm(appRoot));
  fs.mkdirSync(path.join(appRoot, 'packages-local/x-a'), {recursive: true});
  fs.writeFileSync(
    path.join(appRoot, 'packages-local/x-a/package.json'),
    JSON.stringify({name: '@x/a', version: '1.0.0'}),
  );
  fs.writeFileSync(
    path.join(appRoot, 'node_modules/.package-lock.json'),
    JSON.stringify({packages: {'packages-local/x-a': {version: '1.0.0'}}}),
  );

  // The default report writes to console.warn (stderr).
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => warned.push(line);
  try {
    reportDrift(appRoot);
  } finally {
    console.warn = original;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^\[localize\] drift: @x\/a@1\.0\.0 .* "\^2\.0\.0" of <root>$/);

  // A report that throws does not stop the command.
  const program = quietProgram();
  let ran = false;
  installDriftHook(program, () => {
    throw new Error('boom');
  });
  program.command('start').action(() => {
    ran = true;
  });
  await program.parseAsync(['node', 'linked', 'start']);
  assert.equal(ran, true);

  // Neither does an unreadable app.
  assert.doesNotThrow(() => reportDrift(path.join(appRoot, 'does-not-exist')));
});
