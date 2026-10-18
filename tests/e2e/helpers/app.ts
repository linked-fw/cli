// Shared by the e2e specs: scaffold an app from the template with the local CLI
// build, install the CLI under test into it, boot it with `npm start` and read
// the dual-copy guard's lines (cli reports 015 and 017).
//
// `npm start` runs the app's installed `@_linked/cli`, so without the install
// below an e2e would test npm's CLI, not this build. E2E_CLI picks what is
// installed: unset (or `local`) packs this checkout (build it first); any other
// value is an npm spec installed as is, e.g. `E2E_CLI=@_linked/cli@1.50.0` to
// show a check failing on a published release.
import {spawn, execFileSync, type ChildProcess} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI_LAUNCH = join(CLI_ROOT, 'lib/esm/launch.js');

export const GUARD_ON = '[linked] dual-copy guard: on';
export const TWO_COPIES = '[linked] TWO COPIES';

export type ScaffoldedApp = {root: string; dir: string; name: string; cli: string};

/** `linked create-app <name> --skip-install` with this build, in a fresh tmpdir. */
export function scaffoldApp(prefix: string): ScaffoldedApp {
  if (!existsSync(CLI_LAUNCH)) {
    throw new Error(`${CLI_LAUNCH} is missing: run \`npm run build\` first`);
  }
  const name = `${prefix}-${process.pid}`;
  const root = mkdtempSync(join(tmpdir(), 'linked-cli-e2e-'));
  execFileSync(
    'node',
    [
      CLI_LAUNCH,
      'create-app',
      name,
      '--app-name',
      'E2E',
      '--app-prefix',
      'e2e',
      '--app-domain',
      'e2e.local',
      '--skip-install',
    ],
    {cwd: root, stdio: 'inherit'},
  );
  return {root, dir: join(root, name), name, cli: ''};
}

/**
 * `npm install` in the app, then the CLI under test on top of what the
 * template's lockfile resolved. Returns what was installed.
 */
export function installApp(app: ScaffoldedApp): string {
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: app.dir,
    stdio: 'inherit',
  });
  const spec = cliUnderTest(app.root);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--save-dev', spec], {
    cwd: app.dir,
    stdio: 'inherit',
  });
  app.cli = spec;
  console.log(`[e2e] app ${app.dir} runs @_linked/cli from ${spec}`);
  return spec;
}

function cliUnderTest(packDir: string): string {
  const wanted = process.env.E2E_CLI;
  if (wanted && wanted !== 'local') return wanted;
  execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
    cwd: CLI_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarball = readdirSync(packDir).find((f) => /^_linked-cli-.*\.tgz$/.test(f));
  if (!tarball) throw new Error(`npm pack left no tarball in ${packDir}`);
  return join(packDir, tarball);
}

export function removeApp(app: ScaffoldedApp | undefined): void {
  if (app && existsSync(app.root)) rmSync(app.root, {recursive: true, force: true});
}

export type AppRun = {child: ChildProcess; output: () => string};

/**
 * `npm start` in its own process group, stdout and stderr collected together:
 * the guard's status line is `console.log`, its `TWO COPIES` lines are
 * `console.warn`.
 */
export function startApp(app: ScaffoldedApp, env: Record<string, string>): AppRun {
  const child = spawn('npm', ['start'], {
    cwd: app.dir,
    env: {...process.env, ...env},
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });
  let output = '';
  const collect = (chunk: Buffer) => {
    output += chunk;
    process.stdout.write(chunk);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  // Playwright sets FORCE_COLOR, so the app's console colours its values.
  return {child, output: () => output.replace(/\x1b\[[0-9;]*m/g, '')};
}

export function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((done) => child.on('exit', (code) => done(code)));
}

/** Stops the whole group (npm, `linked start` and its server) and waits for npm to exit. */
export async function stopApp(run: AppRun | undefined): Promise<void> {
  const child = run?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timeout = new Promise((done) => setTimeout(done, 10_000));
  await Promise.race([exited(child), timeout]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** Polls `url` until it answers with `status` (any status when omitted). */
export async function waitForHttp(
  url: string,
  run: AppRun,
  timeoutMs: number,
  status?: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline && run.child.exitCode === null) {
    last = await fetch(url).then(
      (r) => r.status,
      () => 0,
    );
    if (last !== 0 && (status === undefined || last === status)) return last;
    await new Promise((done) => setTimeout(done, 1000));
  }
  return last;
}

/** The guard's lines in `output`: the status lines and every `TWO COPIES` line. */
export function guardLines(output: string): {status: string[]; twoCopies: string[]} {
  const lines = output.split(/\r?\n/);
  return {
    status: lines.filter((l) => l.includes('[linked] dual-copy guard:')),
    twoCopies: lines.filter((l) => l.includes(TWO_COPIES)),
  };
}
