/**
 * Real git repositories in a tmp directory for the integration-branch tests.
 * Commits are made with a fixed identity and no user config, so the tests run
 * the same on every machine.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function tmpdir(prefix = 'linked-int-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function rm(dir: string): void {
  fs.rmSync(dir, {recursive: true, force: true});
}

export function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd: dir, env: gitEnv, encoding: 'utf8'}).trim();
}

/** Whether `git <args>` exits 0. */
export function gOk(dir: string, ...args: string[]): boolean {
  try {
    execFileSync('git', args, {cwd: dir, env: gitEnv, stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

export function writeJson(file: string, json: unknown): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** A repository on `main` with one commit holding `package.json` (and `files`). */
export function makeRepo(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  fs.mkdirSync(dir, {recursive: true});
  g(dir, 'init', '-q', '-b', 'main');
  writeJson(path.join(dir, 'package.json'), pkg);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
    fs.writeFileSync(path.join(dir, rel), content);
  }
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function commit(dir: string, file = 'change.txt', message = 'change'): string {
  fs.appendFileSync(path.join(dir, file), `${message}\n`);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', message);
  return g(dir, 'rev-parse', 'HEAD');
}

/**
 * An app repository with `packages-local/_linked-core` and
 * `packages-local/_linked-server` checkouts, all on `main`. The app ignores
 * `node_modules`, `.env` and `*.pem`, and has a real `node_modules/` and `.env`.
 */
export function makeApp(root: string): {
  root: string;
  core: string;
  server: string;
} {
  makeRepo(
    root,
    {name: 'app', private: true, workspaces: ['packages/*', 'packages-local/*']},
    {'.gitignore': 'node_modules/\n.env\n.env.local\n*.pem\npackages-local/\n'},
  );
  fs.mkdirSync(path.join(root, 'node_modules'), {recursive: true});
  fs.writeFileSync(path.join(root, '.env'), 'PORT=4000\n');
  fs.writeFileSync(path.join(root, 'secret.pem'), 'key\n');
  const core = makeRepo(path.join(root, 'packages-local', '_linked-core'), {
    name: '@_linked/core',
    version: '1.0.0',
  });
  const server = makeRepo(path.join(root, 'packages-local', '_linked-server'), {
    name: '@_linked/server',
    version: '1.0.0',
    dependencies: {'@_linked/core': '^1.0.0'},
  });
  return {root, core, server};
}
