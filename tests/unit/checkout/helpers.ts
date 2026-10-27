/**
 * Throwaway "remote" repos for the checkout tests: bare repos under a temp dir, reached by
 * `file://` URLs, so nothing touches the network. An app lists an ontology and an asset package
 * in `linked.unpublishedPackages`; the asset package lists the ontology package.
 */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
