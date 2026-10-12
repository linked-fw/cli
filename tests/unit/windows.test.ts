// What the cli does differently on Windows, checked on any platform: every helper
// takes the platform, so these ask for win32 (and posix) without changing
// process.platform. Nothing here has run on real Windows.
import {spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {browserCommand} from '../../src/commands/start.js';
import {
  ensureAppSetup,
  LOCK_AT_REST_COMMAND,
} from '../../src/localize/app-setup.js';
import {hookScript} from '../../src/localize/git-hooks.js';
import {planPackageSetup} from '../../src/utils/packageSetup.js';
import {
  importSpecifier,
  isPathInside,
  linkDirectory,
  samePath,
  withEolOf,
} from '../../src/utils/platform.js';
import {
  planCommand,
  quoteCmdArg,
  spawnCommandSync,
} from '../../src/utils/spawn.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const hookPlatform = require('../../hooks/platform.cjs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {hookCommands} = require('../../hooks/hook-shim.cjs');

const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const NPX_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const everywhere = () => true;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-windows-'));
});
afterEach(() => {
  fs.rmSync(tmp, {recursive: true, force: true});
});

describe('planCommand', () => {
  test('posix: npm runs as named, without a shell', () => {
    expect(
      planCommand('npm', ['install', 'a b'], {platform: 'darwin'}),
    ).toEqual({
      command: 'npm',
      args: ['install', 'a b'],
      shell: false,
    });
    expect(
      planCommand('npx', ['tsc'], {
        platform: 'linux',
        env: {npm_execpath: NPM_CLI},
      }),
    ).toEqual({
      command: 'npx',
      args: ['tsc'],
      shell: false,
    });
  });

  test("win32: npm runs as node + npm's own npm-cli.js when npm started us", () => {
    const plan = planCommand('npm', ['install', '--no-audit'], {
      platform: 'win32',
      env: {npm_execpath: NPM_CLI},
      execPath: NODE,
      exists: everywhere,
    });
    expect(plan).toEqual({
      command: NODE,
      args: [NPM_CLI, 'install', '--no-audit'],
      shell: false,
    });
  });

  test('win32: npx runs as node + npx-cli.js next to npm-cli.js', () => {
    const plan = planCommand('npx', ['--no-install', 'linked'], {
      platform: 'win32',
      env: {npm_execpath: NPM_CLI},
      execPath: NODE,
      exists: (p) => p === NPX_CLI,
    });
    expect(plan).toEqual({
      command: NODE,
      args: [NPX_CLI, '--no-install', 'linked'],
      shell: false,
    });
  });

  test('win32: without npm_execpath, npm.cmd through cmd.exe, every argument quoted and escaped twice', () => {
    // npm.cmd hands `%*` to another command line, which cmd.exe parses again.
    const plan = planCommand(
      'npm',
      ['install', '--cache', 'C:\\Users\\First Last\\Temp'],
      {
        platform: 'win32',
        env: {},
      },
    );
    expect(plan.shell).toBe(true);
    expect(plan.args).toEqual([]);
    expect(plan.command).toBe(
      'npm.cmd ^^^"install^^^" ^^^"--cache^^^" ^^^"C:\\Users\\First^^^ Last\\Temp^^^"',
    );
  });

  test('win32: every .cmd shim that re-parses %* escapes twice; any other batch file once', () => {
    const twice = '^^^"a^^^&b^^^"';
    for (const cmd of [
      'npx',
      'tsc',
      'linked',
      'NPM.CMD',
      'C:\\Program Files\\nodejs\\npx.cmd',
    ]) {
      const plan = planCommand(cmd, ['a&b'], {platform: 'win32', env: {}});
      expect(plan.command.endsWith(` ${twice}`)).toBe(true);
    }
    expect(planCommand('tsc', ['a&b'], {platform: 'win32'}).command).toBe(
      `tsc.cmd ${twice}`,
    );
    expect(
      planCommand('C:\\tools\\build.cmd', ['a&b'], {platform: 'win32'}).command,
    ).toBe('C:\\tools\\build.cmd ^"a^&b^"');
    expect(
      planCommand('C:\\tools\\npm.bat', ['a&b'], {platform: 'win32'}).command,
    ).toBe('C:\\tools\\npm.bat ^"a^&b^"');
  });

  test('win32: started by npx (npx-cli.js), npm runs as node + the npm-cli.js beside it', () => {
    const plan = planCommand('npm', ['install'], {
      platform: 'win32',
      env: {npm_execpath: NPX_CLI},
      execPath: NODE,
      exists: (p) => p === NPM_CLI,
    });
    expect(plan).toEqual({
      command: NODE,
      args: [NPM_CLI, 'install'],
      shell: false,
    });
    expect(
      planCommand('npx', ['linked'], {
        platform: 'win32',
        env: {npm_execpath: NPX_CLI},
        execPath: NODE,
        exists: (p) => p === NPX_CLI,
      }),
    ).toEqual({command: NODE, args: [NPX_CLI, 'linked'], shell: false});
    // No npm-cli.js beside it: npm.cmd through cmd.exe.
    const fallback = planCommand('npm', ['install'], {
      platform: 'win32',
      env: {npm_execpath: NPX_CLI},
      exists: () => false,
    });
    expect(fallback.shell).toBe(true);
    expect(fallback.command.startsWith('npm.cmd ')).toBe(true);
  });

  test("win32: yarn's npm_execpath is not npm's, so npm.cmd it is", () => {
    const plan = planCommand('npm', ['view', 'x'], {
      platform: 'win32',
      env: {npm_execpath: 'C:\\yarn\\bin\\yarn.js'},
      exists: everywhere,
    });
    expect(plan.command.startsWith('npm.cmd ')).toBe(true);
    expect(plan.shell).toBe(true);
  });

  test('win32: a node_modules/.bin shim is quoted, and its metacharacters escaped twice', () => {
    const plan = planCommand(
      'C:\\app\\node_modules\\.bin\\tsc.cmd',
      ['-p', 'a&b'],
      {platform: 'win32'},
    );
    expect(plan.command).toBe(
      'C:\\app\\node_modules\\.bin\\tsc.cmd ^^^"-p^^^" ^^^"a^^^&b^^^"',
    );
    expect(plan.shell).toBe(true);
  });

  test('win32: git and gh are executables and run as they are', () => {
    expect(
      planCommand('git', ['clone', '--', 'u', 'C:\\a b'], {platform: 'win32'}),
    ).toEqual({
      command: 'git',
      args: ['clone', '--', 'u', 'C:\\a b'],
      shell: false,
    });
  });

  test('posix: an argument with spaces reaches the program as one argument', () => {
    const r = spawnCommandSync(
      process.execPath,
      ['-e', 'console.log(process.argv[1])', 'a b "c"'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.stdout.trim()).toBe('a b "c"');
  });
});

describe('quoteCmdArg', () => {
  test('quotes for the C runtime, then escapes cmd.exe metacharacters', () => {
    expect(quoteCmdArg('plain')).toBe('^"plain^"');
    expect(quoteCmdArg('a b')).toBe('^"a^ b^"');
    expect(quoteCmdArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    // A trailing backslash would escape the closing quote: it is doubled.
    expect(quoteCmdArg('C:\\dir\\')).toBe('^"C:\\dir\\\\^"');
    expect(quoteCmdArg('100%')).toBe('^"100^%^"');
  });
});

describe('paths on win32', () => {
  test('samePath ignores case and separators on win32 only', () => {
    expect(samePath('C:\\Repo\\.git', 'c:/repo/.git', 'win32')).toBe(true);
    expect(samePath('/repo/.git', '/Repo/.git', 'darwin')).toBe(false);
    expect(samePath('/repo/x/../.git', '/repo/.git', 'linux')).toBe(true);
  });

  test('isPathInside ignores case and separators on win32 only', () => {
    expect(isPathInside('c:/App/src/x.ts', 'C:\\app\\src', 'win32')).toBe(true);
    expect(isPathInside('C:\\app\\srcx\\x.ts', 'C:\\app\\src', 'win32')).toBe(
      false,
    );
    expect(isPathInside('/app/Src/x.ts', '/app/src', 'linux')).toBe(false);
    expect(isPathInside('/app/src', '/app/src', 'linux')).toBe(true);
  });

  test('isPathInside: a child named `..foo` is inside; `..` and `../x` are not', () => {
    expect(isPathInside('/app/src/..foo', '/app/src', 'linux')).toBe(true);
    expect(isPathInside('/app/src/..foo/x.ts', '/app/src', 'linux')).toBe(true);
    expect(isPathInside('/app', '/app/src', 'linux')).toBe(false);
    expect(isPathInside('/app/x', '/app/src', 'linux')).toBe(false);
    expect(isPathInside('C:\\app\\src\\..foo', 'C:\\app\\src', 'win32')).toBe(
      true,
    );
    expect(isPathInside('c:/app/src/..foo/x.ts', 'C:\\app\\src', 'win32')).toBe(
      true,
    );
    expect(isPathInside('C:\\app', 'C:\\app\\src', 'win32')).toBe(false);
    expect(isPathInside('C:\\app\\x', 'C:\\app\\src', 'win32')).toBe(false);
    expect(isPathInside('D:\\app\\src', 'C:\\app\\src', 'win32')).toBe(false);
  });

  test('a directory link is a junction to the absolute target on win32', () => {
    const calls: unknown[][] = [];
    linkDirectory(
      'C:\\app\\packages-local\\.repos\\mono\\pkg',
      'C:\\app\\packages-local\\pkg',
      'win32',
      (...a) => {
        calls.push(a);
      },
    );
    expect(calls).toEqual([
      [
        'C:\\app\\packages-local\\.repos\\mono\\pkg',
        'C:\\app\\packages-local\\pkg',
        'junction',
      ],
    ]);
  });

  test('a directory link is a relative symlink elsewhere', () => {
    const target = path.join(tmp, 'packages-local', '.repos', 'mono', 'pkg');
    const link = path.join(tmp, 'packages-local', 'pkg');
    fs.mkdirSync(target, {recursive: true});
    linkDirectory(
      target,
      link,
      process.platform === 'win32' ? 'linux' : process.platform,
    );
    expect(fs.readlinkSync(link)).toBe(path.join('.repos', 'mono', 'pkg'));
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
  });

  test('import() gets a file: URL on win32, the path itself elsewhere', () => {
    expect(importSpecifier('C:\\My App\\linked.config.js', 'win32')).toBe(
      'file:///C:/My%20App/linked.config.js',
    );
    expect(importSpecifier('/my app/linked.config.js', 'darwin')).toBe(
      '/my app/linked.config.js',
    );
  });
});

describe('line endings', () => {
  test('withEolOf keeps CRLF and leaves LF alone', () => {
    expect(withEolOf('a\nb\r\nc\n', 'x\r\ny')).toBe('a\r\nb\r\nc\r\n');
    expect(withEolOf('a\nb\n', 'x\ny')).toBe('a\nb\n');
  });

  test('the localize set-up keeps a CRLF package.json and .gitignore CRLF', () => {
    const pkg = '{\r\n  "name": "app",\r\n  "version": "1.0.0"\r\n}\r\n';
    fs.writeFileSync(path.join(tmp, 'package.json'), pkg);
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules\r\nlib\r\n');
    expect(ensureAppSetup(tmp).length).toBeGreaterThan(0);
    for (const file of ['package.json', '.gitignore']) {
      const text = fs.readFileSync(path.join(tmp, file), 'utf8');
      expect(text.replace(/\r\n/g, '')).not.toContain('\n');
      expect(text.endsWith('\r\n')).toBe(true);
    }
    expect(
      JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'))
        .workspaces,
    ).toEqual(['packages-local/*']);
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toContain(
      'packages-local/\r\n',
    );
  });
});

describe('commands written for a shell', () => {
  test('the lock-at-rest guard is one double-quoted node -e that cmd.exe passes through', () => {
    const m = /^node -e "([^"]*)"$/.exec(LOCK_AT_REST_COMMAND);
    expect(m).not.toBeNull();
    const js = m![1];
    // Inside cmd.exe's double quotes `&&` is literal; these would still be read by it.
    expect(js).not.toMatch(/[%^!"`$\\]/);
    expect(() => new Function(js)).not.toThrow();
  });

  test('the build command quotes node and the launch script for cmd.exe on win32', () => {
    const plan = planPackageSetup(
      '',
      'C:\\Program Files\\cli\\lib\\esm\\launch.js',
      NODE,
      false,
      'win32',
    );
    expect(plan.buildCommand).toBe(
      `"${NODE}" "C:\\Program Files\\cli\\lib\\esm\\launch.js" build`,
    );
    expect(
      planPackageSetup(
        '',
        '/opt/cli/launch.js',
        '/usr/bin/node',
        false,
        'linux',
      ).buildCommand,
    ).toBe('"/usr/bin/node" "/opt/cli/launch.js" build');
  });

  test('the browser opens through explorer.exe on win32, never the `start` built-in', () => {
    expect(browserCommand('http://localhost:4040/', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['http://localhost:4040/'],
    });
    expect(browserCommand('http://x/', 'darwin').command).toBe('open');
    expect(browserCommand('http://x/', 'linux').command).toBe('xdg-open');
  });
});

describe('hooks (plain CommonJS)', () => {
  test('npm in a git hook: npm.cmd through cmd.exe on win32, npm elsewhere', () => {
    expect(
      hookPlatform.npmCommand(['install', '--no-audit', '--no-fund'], 'win32'),
    ).toEqual({
      command: 'npm.cmd install --no-audit --no-fund',
      args: [],
      shell: true,
    });
    expect(hookPlatform.npmCommand(['install'], 'darwin')).toEqual({
      command: 'npm',
      args: ['install'],
      shell: false,
    });
    expect(() => hookPlatform.npmCommand(['a b'], 'win32')).toThrow(/unsafe/);
  });

  test('no /dev/tty on win32', () => {
    expect(hookPlatform.terminalDevice('win32')).toBeNull();
    expect(hookPlatform.terminalDevice('linux')).toBe('/dev/tty');
  });

  test("the hook's sh leaves a Windows-style absolute GIT_DIR alone and anchors a relative one", () => {
    const line = (hookCommands('pre-commit', '') as string[]).find((l) =>
      l.startsWith('for v in'),
    );
    expect(line).toBeDefined();
    const run = (gitDir: string) =>
      spawnSync('sh', ['-c', `${line}; printf %s "$GIT_DIR"`], {
        cwd: tmp,
        encoding: 'utf8',
        env: {PATH: process.env.PATH, GIT_DIR: gitDir},
      }).stdout;
    expect(run('C:/Users/me/app/.git')).toBe('C:/Users/me/app/.git');
    expect(run('C:\\Users\\me\\app\\.git')).toBe('C:\\Users\\me\\app\\.git');
    expect(run('/repo/.git')).toBe('/repo/.git');
    expect(run('.git')).toBe(
      `${spawnSync('sh', ['-c', 'printf %s "$PWD"'], {cwd: tmp, encoding: 'utf8'}).stdout}/.git`,
    );
  });

  test('hook files are LF-only sh, as Git for Windows runs them', () => {
    const text = hookScript('post-merge', 'apps/web/');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).not.toContain('\r');
  });
});
