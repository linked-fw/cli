// `linked yarn` is a plain passthrough to yarn. It used to read a multi-repo
// manifest from the cwd and back up the yarn.lock of every nested sibling repo
// it listed; that tool is retired, so the manifest is never read and nested
// lockfiles are never touched — the tests below pin that removal, not just the
// arg forwarding. The dry-run coverage closes a deferred gap from
// docs/backlog/010-cli-test-harness.md.
jest.mock('../../src/utils.js', () => ({
  __esModule: true,
  execp: jest.fn(async () => undefined),
}));

import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {safeYarn} from '../../src/commands/safe-yarn.js';
import {execp} from '../../src/utils.js';

const execpMock = execp as unknown as jest.Mock;

describe('safeYarn (dry-run)', () => {
  const originalEnv = process.env.LINKED_YARN_DRY_RUN;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.LINKED_YARN_DRY_RUN = '1';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    execpMock.mockClear();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LINKED_YARN_DRY_RUN;
    } else {
      process.env.LINKED_YARN_DRY_RUN = originalEnv;
    }
    logSpy.mockRestore();
  });

  test('passes a plain install through', async () => {
    await safeYarn(['install']);
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toMatch(/yarn install/);
    expect(joined).toMatch(/\["install"\]/);
  });

  test('preserves multi-word args', async () => {
    await safeYarn(['workspace', '@_linked/core', 'build']);
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toMatch(/yarn workspace @_linked\/core build/);
    expect(joined).toMatch(/\["workspace","@_linked\/core","build"\]/);
  });

  test('preserves --flag style args', async () => {
    await safeYarn(['install', '--immutable']);
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toMatch(/yarn install --immutable/);
  });

  test('preserves quoted-style empty args list', async () => {
    await safeYarn([]);
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).toMatch(/would execute: yarn /);
    expect(joined).toMatch(/\[\]/);
  });

  test('returns synchronously without throwing on minimal args', async () => {
    await expect(safeYarn(['--version'])).resolves.toBeUndefined();
  });

  test('does not execute yarn in dry-run mode', async () => {
    await safeYarn(['install']);
    expect(execpMock).not.toHaveBeenCalled();
  });
});

describe('safeYarn (no nested-repo handling)', () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env.LINKED_YARN_DRY_RUN;
  let dir: string;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.LINKED_YARN_DRY_RUN;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-yarn-'));
    // A nested repo's lockfile: nothing may back it up, move it or truncate it.
    fs.outputFileSync(
      path.join(dir, 'packages', 'core', 'yarn.lock'),
      'nested lockfile\n',
    );
    process.chdir(dir);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    execpMock.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(dir);
    if (originalEnv === undefined) {
      delete process.env.LINKED_YARN_DRY_RUN;
    } else {
      process.env.LINKED_YARN_DRY_RUN = originalEnv;
    }
    logSpy.mockRestore();
  });

  test('runs yarn once, unconditionally', async () => {
    await safeYarn(['install']);
    expect(execpMock).toHaveBeenCalledTimes(1);
    expect(execpMock).toHaveBeenCalledWith('yarn install', true, false);
  });

  test('leaves nested lockfiles untouched and writes no .bak', async () => {
    const lock = path.join(dir, 'packages', 'core', 'yarn.lock');
    await safeYarn(['install']);
    expect(fs.readFileSync(lock, 'utf8')).toBe('nested lockfile\n');
    expect(fs.existsSync(lock + '.bak')).toBe(false);
  });

  test('says nothing about preserving nested lockfiles', async () => {
    await safeYarn(['install']);
    const joined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(joined).not.toMatch(/Preserving/i);
    expect(joined).not.toMatch(/nested/i);
  });
});

describe('safe-yarn source', () => {
  test('reads no manifest from the cwd', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/commands/safe-yarn.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.json/);
    expect(source).not.toMatch(/process\.cwd/);
    expect(source).not.toMatch(/existsSync|readFileSync|renameSync/);
  });
});
