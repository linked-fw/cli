/**
 * Throwaway "remote" repos for the checkout tests: bare repos under a temp dir, reached by
 * `file://` URLs, so nothing touches the network. An app lists an ontology and an asset package
 * in `linked.unpublishedPackages`; the asset package lists the ontology package.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {checkout, type CheckoutOptions, type CheckoutResult} from '../../../src/commands/checkout.js';

export const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'checkout tests',
  GIT_AUTHOR_EMAIL: 'tests@checkout.invalid',
  GIT_COMMITTER_NAME: 'checkout tests',
  GIT_COMMITTER_EMAIL: 'tests@checkout.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

export function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface Remotes {
  /** Holds the bare remotes and the scratch clones that write to them. */
  base: string;
  app: string;
  ont: string;
  assets: string;
  url: (remote: string) => string;
}

/** A bare repo `<base>/remotes/acme/<name>.git` whose `main` has `files`. */
export function makeRemote(base: string, name: string, files: Record<string, string>): string {
  const bare = path.join(base, 'remotes', 'acme', `${name}.git`);
  fs.mkdirSync(path.dirname(bare), {recursive: true});
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  const work = path.join(base, 'scratch', name);
  git(base, 'clone', '-q', bare, work);
  git(work, 'switch', '-q', '-c', 'main');
  git(work, 'config', 'core.hooksPath', '/dev/null');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), {recursive: true});
    fs.writeFileSync(path.join(work, file), content);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'initial');
  git(work, 'push', '-q', 'origin', 'main');
  return bare;
}

/** Commit `file` on `branch` of `remote` (created from main when missing) and push it; returns the sha. */
export function commitOn(base: string, remote: string, branch: string, file: string, content: string): string {
  const work = path.join(base, 'scratch', path.basename(remote, '.git'));
  git(work, 'fetch', '-q', 'origin');
  const has = (() => {
    try {
      git(work, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
      return true;
    } catch {
      return false;
    }
  })();
  git(work, 'switch', '-q', '-C', branch, has ? `origin/${branch}` : 'origin/main');
  fs.mkdirSync(path.dirname(path.join(work, file)), {recursive: true});
  fs.writeFileSync(path.join(work, file), content);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', `${file} on ${branch}`);
  git(work, 'push', '-q', 'origin', `${branch}:${branch}`);
  return git(work, 'rev-parse', 'HEAD');
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/**
 * The app `acme-app` lists `acme-ont` and `acme-assets`; `acme-assets` lists `acme-ont`. Only the
 * asset repo has `change-1`. The app is set up for checkouts (workspaces, .gitignore).
 */
export function makeRemotes(): Remotes {
  const base = tmp('checkout-remotes-');
  const url = (remote: string) => `file://${remote}`;
  const ont = makeRemote(base, 'acme-ont', {
    'package.json': json({name: 'acme-ont', version: '1.0.0', linked: {kind: 'ontology'}}),
    'ont.ttl': '# ontology\n',
  });
  const assets = makeRemote(base, 'acme-assets', {
    'package.json': json({
      name: 'acme-assets',
      version: '1.0.0',
      linked: {kind: 'assets', unpublishedPackages: {'acme-ont': {repo: url(ont)}}},
    }),
  });
  const app = makeRemote(base, 'acme-app', {
    'package.json': json({
      name: 'acme-app',
      version: '1.0.0',
      private: true,
      workspaces: ['packages-local/*'],
      linked: {
        kind: 'app',
        unpublishedPackages: {'acme-ont': {repo: url(ont)}, 'acme-assets': {repo: url(assets)}},
      },
    }),
    '.gitignore': 'node_modules/\npackages-local/\n.packages-local.parked/\n',
  });
  commitOn(base, assets, 'change-1', 'assets.txt', 'on change-1\n');
  return {base, app, ont, assets, url};
}

/** The app's `package.json` with `branch` keys on the entries `keys` names (npm name -> branch). */
export function appJsonWithKeys(r: Remotes, keys: Record<string, string>): string {
  const entry = (name: string, remote: string) => ({repo: r.url(remote), ...(keys[name] ? {branch: keys[name]} : {})});
  return json({
    name: 'acme-app',
    version: '1.0.0',
    private: true,
    workspaces: ['packages-local/*'],
    linked: {
      kind: 'app',
      unpublishedPackages: {'acme-ont': entry('acme-ont', r.ont), 'acme-assets': entry('acme-assets', r.assets)},
    },
  });
}

/** Commit the app's `package.json` with `branch` keys on app branch `branch`; returns the sha. */
export function keyAppBranch(r: Remotes, branch: string, keys: Record<string, string>): string {
  return commitOn(r.base, r.app, branch, 'package.json', appJsonWithKeys(r, keys));
}

/** The fake token every checkout test runs with. */
export const TOKEN = 'ghs_checkoutE2eFakeToken';

const dirs: string[] = [];
/** Remove every temp dir `setup` made; for `afterEach`. */
export function cleanup(): void {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
}

/** Every git config file under `root`: base clones, worktree configs. */
function configFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules') walk(p);
      else if (e.isFile() && /^config(\.worktree)?$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** No token and no userinfo in any config under `root`, nor in any remote URL of a base clone. */
export function assertNoToken(root: string): void {
  const files = configFiles(root);
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!text.includes(TOKEN), `${f} holds the token`);
    assert.ok(!/:\/\/[^/\s]*@/.test(text), `${f} holds a URL with userinfo`);
  }
  const repos = path.join(root, '.repos', 'acme');
  for (const b of fs.readdirSync(repos)) {
    const urls = git(path.join(repos, b), 'config', '--get-regexp', 'remote\\..*\\.url');
    assert.ok(!urls.includes(TOKEN) && !urls.includes('@'), urls);
  }
}

export function setup(): {r: Remotes; root: string; run: (branch: string, o?: CheckoutOptions) => CheckoutResult} {
  const r = makeRemotes();
  const root = tmp('checkout-root-');
  dirs.push(r.base, root);
  const env = {...gitEnv, LINKED_GIT_TOKEN: TOKEN};
  const run = (branch: string, o: CheckoutOptions = {}) =>
    checkout(branch, {repo: r.url(r.app), root, install: false, env, cwd: root, ...o});
  return {r, root, run};
}

