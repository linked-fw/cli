/**
 * The one way the cli starts `npm`, `npx` and other command shims with an
 * argument list.
 *
 * On macOS and Linux a command runs as it is named, without a shell. On
 * Windows `npm`, `npx`, `yarn` and every `node_modules/.bin` entry are `.cmd`
 * batch files, which Node refuses to spawn without a shell (EINVAL since
 * Node 18.20.2 / 20.12.2, CVE-2024-27980). There:
 *
 * - `npm` and `npx` run as `node <npm-cli.js|npx-cli.js>` when the npm that
 *   started this process says where it lives (`npm_execpath`): no shell, no
 *   quoting;
 * - any other shim runs through `cmd.exe` as one command line, each argument
 *   quoted for it;
 * - everything else (`git`, `gh`, `node`) is an `.exe` and runs as it is.
 *
 * Commands given as one shell string (`exec`, a configured build command) go
 * to the platform's shell as they are; they must not use POSIX-only syntax.
 */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CommandPlan {
  command: string;
  args: string[];
  shell: boolean;
}

export interface PlanOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The node binary that runs npm's own scripts; `process.execPath` by default. */
  execPath?: string;
  /** Injectable for tests; `fs.existsSync` by default. */
  exists?: (p: string) => boolean;
}

/** Names that are batch-file shims on Windows, not executables. */
const WINDOWS_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'corepack', 'linked', 'tsc', 'vite']);

/** What `cmd.exe` treats specially outside quotes (cross-spawn's set). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * `arg` as one argument on a `cmd.exe` command line: quoted the way the C
 * runtime splits arguments, then every `cmd.exe` metacharacter escaped with
 * `^` -- twice for a `node_modules/.bin` shim, whose `%*` is parsed again.
 * The same scheme as cross-spawn.
 */
export function quoteCmdArg(arg: string, doubleEscape = false): string {
  let quoted = arg
    // Backslashes before a quote are doubled, and the quote escaped.
    .replace(/(\\*)"/g, '$1$1\\"')
    // Backslashes before the closing quote are doubled.
    .replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`.replace(CMD_META, '^$1');
  return doubleEscape ? quoted.replace(CMD_META, '^$1') : quoted;
}

/** Is `cmd` a batch-file shim on Windows: a known name, a `.cmd`/`.bat` path, or a `.bin` entry? */
function isWindowsShim(cmd: string): boolean {
  if (/\.(cmd|bat)$/i.test(cmd)) return true;
  if (/(^|[\\/])node_modules[\\/]\.bin[\\/]/i.test(cmd)) return true;
  return WINDOWS_SHIMS.has(cmd.toLowerCase());
}

/**
 * The JS entry of npm's `npm` or `npx`, from `npm_execpath` -- which npm sets
 * for every script and `npx` it runs. Only npm's own: under yarn or pnpm it
 * names their entry, which takes other arguments.
 */
function npmScript(
  cmd: 'npm' | 'npx',
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string | null {
  const execPath = env.npm_execpath;
  if (!execPath || !/^npm-cli\.js$/i.test(path.win32.basename(execPath))) return null;
  const script =
    cmd === 'npm' ? execPath : path.win32.join(path.win32.dirname(execPath), 'npx-cli.js');
  return exists(script) ? script : null;
}

/** How to start `cmd` with `args` on `platform`; see the module comment. */
export function planCommand(
  cmd: string,
  args: readonly string[],
  opts: PlanOptions = {},
): CommandPlan {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || !isWindowsShim(cmd)) {
    return {command: cmd, args: [...args], shell: false};
  }
  const name = cmd.toLowerCase();
  if (name === 'npm' || name === 'npx') {
    const script = npmScript(name, opts.env ?? process.env, opts.exists ?? fs.existsSync);
    if (script) {
      return {command: opts.execPath ?? process.execPath, args: [script, ...args], shell: false};
    }
  }
  const file = /\.(cmd|bat|exe)$/i.test(cmd) || !WINDOWS_SHIMS.has(name) ? cmd : `${cmd}.cmd`;
  const doubleEscape = /(^|[\\/])node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [
    // A path with spaces is quoted; a bare name stays bare so cmd.exe searches PATH for it.
    /[\s"]/.test(file) ? quoteCmdArg(file) : file,
    ...args.map((a) => quoteCmdArg(a, doubleEscape)),
  ].join(' ');
  return {command: line, args: [], shell: true};
}

/**
 * `spawnSync` for an argument list, planned by `planCommand`. A `shell` in
 * `options` is ignored: whether a shell is needed is the plan's call.
 */
export function spawnCommandSync(
  cmd: string,
  args: readonly string[],
  options: SpawnSyncOptions & {encoding: BufferEncoding},
): SpawnSyncReturns<string> {
  const plan = planCommand(cmd, args, {env: options.env});
  return spawnSync(plan.command, plan.args, {...options, shell: plan.shell});
}

/** `spawn` for an argument list, planned by `planCommand`. */
export function spawnCommand(
  cmd: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const plan = planCommand(cmd, args, {env: options.env});
  return spawn(plan.command, plan.args, {...options, shell: plan.shell});
}

export interface CommandOutput {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `cmd` with `args` and collect its output; resolves (never rejects) with
 * the exit status, 1 when it could not start. `echo` also streams the output.
 */
export function runCommand(
  cmd: string,
  args: readonly string[],
  options: SpawnOptions & {echo?: boolean; input?: string} = {},
): Promise<CommandOutput> {
  const {echo, input, ...spawnOptions} = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawnCommand(cmd, args, {...spawnOptions, stdio: 'pipe'});
    } catch (e) {
      resolve({status: 1, stdout, stderr: String((e as Error).message ?? e)});
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (echo) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    child.on('error', (e) => resolve({status: 1, stdout, stderr: stderr + e.message}));
    child.on('close', (code) => resolve({status: code ?? 1, stdout, stderr}));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}
