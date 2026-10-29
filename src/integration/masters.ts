/**
 * Masters: integration branches that live in a worktree of their own
 * (`linked branch start <m> --worktree`), so the owner's checkouts stay on his
 * stable branch.
 *
 * A master is recorded in git config, which every worktree of a repo shares:
 * in each repo of the master `branch.<m>.linked-target` (the branch it lands
 * in, as for any integration branch) and `branch.<m>.linked-worktree` (that
 * repo's worktree of `<m>`); in the app repo also `branch.<m>.linked-port`
 * (its preview port) and `branch.<m>.linked-dataset` (when it has one).
 */
import {getTarget} from './repos.js';
import type {Run} from '../localize/run.js';

export interface Master {
  name: string;
  /** The app worktree on `<m>`. */
  dir: string;
  /** The app repo's target for `<m>`. */
  target: string | null;
  port: number | null;
  dataset: string | null;
}

/** Preview ports: one slot per master, `45k0` for k = 1..9, outside a CN's live-app band 4000-4399. */
export const MASTER_PORTS = [4510, 4520, 4530, 4540, 4550, 4560, 4570, 4580, 4590];

function configGet(run: Run, repoDir: string, key: string): string | null {
  const r = run('git', ['config', '--get', key], {cwd: repoDir});
  const v = r.stdout.trim();
  return r.status === 0 && v ? v : null;
}

/** The master `<name>` recorded in the repo at `repoDir`, or null when `<name>` is not one. */
export async function masterOf(run: Run, repoDir: string, name: string): Promise<Master | null> {
  const dir = configGet(run, repoDir, `branch.${name}.linked-worktree`);
  if (!dir) return null;
  const port = Number.parseInt(configGet(run, repoDir, `branch.${name}.linked-port`) ?? '', 10);
  return {
    name,
    dir,
    target: await getTarget(repoDir, name, run),
    port: Number.isInteger(port) ? port : null,
    dataset: configGet(run, repoDir, `branch.${name}.linked-dataset`),
  };
}

/** Every master recorded in the repo at `repoDir`, by name. */
export async function listMasters(run: Run, repoDir: string): Promise<Master[]> {
  const r = run('git', ['config', '--get-regexp', '^branch\\..*\\.linked-worktree$'], {cwd: repoDir});
  if (r.status !== 0) return [];
  const names = r.stdout
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter((key) => key.startsWith('branch.') && key.endsWith('.linked-worktree'))
    .map((key) => key.slice('branch.'.length, -'.linked-worktree'.length));
  const masters: Master[] = [];
  for (const name of [...new Set(names)].sort()) {
    const m = await masterOf(run, repoDir, name);
    if (m) masters.push(m);
  }
  return masters;
}

/** The first preview port no recorded master holds; null when all nine are taken. */
export function freeMasterPort(masters: Master[]): number | null {
  const held = new Set(masters.map((m) => m.port));
  return MASTER_PORTS.find((p) => !held.has(p)) ?? null;
}

/**
 * The step ports of a master on port `port`: `port + 2` to `port + 9`
 * (`port + 1` is the master's test runs).
 */
export const stepPorts = (port: number): string => `${port + 2}-${port + 9}`;

/** Remove the worktree records of `<name>` from the repo at `repoDir`; the target stays with the branch. */
export function forgetMaster(run: Run, repoDir: string, name: string): void {
  for (const key of ['linked-worktree', 'linked-port', 'linked-dataset']) {
    run('git', ['config', '--unset', `branch.${name}.${key}`], {cwd: repoDir});
  }
}
