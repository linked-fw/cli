/**
 * Credentials through the environment only: what a remote git call gets, what everything else
 * gets, URL and error-text scrubbing, and the askpass hook -- driven directly and through a real
 * `git credential fill`, which asks the askpass program exactly as a clone over HTTPS would.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  gitRemoteEnv,
  localEnv,
  remoteEnv,
  scrubSecret,
  stripUserinfo,
} from '../../../src/integration/credentials.js';

const ASKPASS = path.resolve(__dirname, '../../../hooks/git-askpass.cjs');
const TOKEN = 'ghs_fakeTokenForTests123';

describe('gitRemoteEnv', () => {
  test('no token: nothing added', () => {
    assert.deepEqual(gitRemoteEnv({PATH: '/bin'}), {});
    assert.deepEqual(remoteEnv({PATH: '/bin'}), {PATH: '/bin'});
  });

  test('a token: askpass, no terminal prompt, credential.helper reset; the token itself is not added', () => {
    const added = gitRemoteEnv({LINKED_GIT_TOKEN: TOKEN});
    assert.equal(added.GIT_ASKPASS, ASKPASS);
    assert.equal(added.GIT_TERMINAL_PROMPT, '0');
    assert.equal(added.GIT_CONFIG_COUNT, '1');
    assert.equal(added.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.equal(added.GIT_CONFIG_VALUE_0, '');
    assert.ok(!Object.values(added).some((v) => v.includes(TOKEN)));
  });

  test('an existing GIT_CONFIG_COUNT is extended', () => {
    const added = gitRemoteEnv({LINKED_GIT_TOKEN: TOKEN, GIT_CONFIG_COUNT: '2'});
    assert.equal(added.GIT_CONFIG_COUNT, '3');
    assert.equal(added.GIT_CONFIG_KEY_2, 'credential.helper');
  });

  test('the askpass hook is executable', () => {
    fs.accessSync(ASKPASS, fs.constants.X_OK);
  });
});

describe('localEnv', () => {
  test('removes the token and its username, keeps the rest', () => {
    assert.deepEqual(localEnv({LINKED_GIT_TOKEN: TOKEN, LINKED_GIT_USERNAME: 'u', PATH: '/bin'}), {PATH: '/bin'});
  });
});

describe('stripUserinfo and scrubSecret', () => {
  test('stripUserinfo', () => {
    assert.deepEqual(stripUserinfo('https://x-access-token:abc@github.com/o/r.git'), {
      url: 'https://github.com/o/r.git',
      stripped: true,
    });
    assert.deepEqual(stripUserinfo('https://github.com/o/r.git'), {url: 'https://github.com/o/r.git', stripped: false});
    assert.deepEqual(stripUserinfo('file:///tmp/r.git'), {url: 'file:///tmp/r.git', stripped: false});
  });

  test('scrubSecret removes the token and any userinfo', () => {
    const text = `fatal: could not read from https://x-access-token:${TOKEN}@github.com/o/r.git (${TOKEN})`;
    const out = scrubSecret(text, {LINKED_GIT_TOKEN: TOKEN});
    assert.ok(!out.includes(TOKEN));
    assert.equal(out, 'fatal: could not read from https://github.com/o/r.git (***)');
  });
});

describe('hooks/git-askpass.cjs', () => {
  const ask = (prompt: string, env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [ASKPASS, prompt], {encoding: 'utf8', env});

  test('answers both prompts', () => {
    const user = ask("Username for 'https://github.com': ", {LINKED_GIT_TOKEN: TOKEN});
    assert.equal(user.status, 0);
    assert.equal(user.stdout, 'x-access-token\n');
    const pass = ask("Password for 'https://x-access-token@github.com': ", {LINKED_GIT_TOKEN: TOKEN});
    assert.equal(pass.stdout, `${TOKEN}\n`);
    const named = ask("Username for 'https://github.com': ", {LINKED_GIT_TOKEN: TOKEN, LINKED_GIT_USERNAME: 'bot'});
    assert.equal(named.stdout, 'bot\n');
  });

  test('exits 1 without a token, or for another prompt', () => {
    assert.equal(ask("Password for 'https://github.com': ", {}).status, 1);
    assert.equal(ask('Are you sure (yes/no)? ', {LINKED_GIT_TOKEN: TOKEN}).status, 1);
  });

  test('git asks it, with the keychain helper bypassed (git credential fill)', () => {
    // A helper that would answer with other credentials: the reset must keep git from asking it.
    const helperLog = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'helper-')), 'asked');
    const env = {
      ...process.env,
      LINKED_GIT_TOKEN: TOKEN,
      ...gitRemoteEnv({LINKED_GIT_TOKEN: TOKEN}),
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: path.dirname(helperLog),
      XDG_CONFIG_HOME: path.dirname(helperLog),
    };
    fs.writeFileSync(
      path.join(path.dirname(helperLog), '.gitconfig'),
      `[credential]\n\thelper = "!f() { echo asked > '${helperLog}'; echo username=wrong; echo password=wrong; }; f"\n`,
    );
    const r = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\npath=o/r.git\n\n',
      encoding: 'utf8',
      env,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^username=x-access-token$/m);
    assert.match(r.stdout, new RegExp(`^password=${TOKEN}$`, 'm'));
    assert.ok(!fs.existsSync(helperLog), 'the configured credential helper was asked');
    fs.rmSync(path.dirname(helperLog), {recursive: true, force: true});
  });
});
