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
 *
 * The app's git config is the record of its own masters. Whether a preview port is taken on this
 * machine (by any app's master) is answered by the port registry
 * `<linkedHome()>/master-ports.json`, `{"<port>": {app, master, dir}}`, read and written only
 * inside the machine lock `master-ports` (`withMachineLockAsync`). An entry whose `dir` is gone
 * does not count, and is dropped at the next write.
 */
import fs from 'node:fs';
import path from 'node:path';

import {linkedHome} from './repo-lock.js';
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

/** The machine lock (`withMachineLockAsync`) around choosing, recording and releasing a port. */
export const MASTER_PORTS_LOCK = 'master-ports';

/** A preview port a master holds on this machine. */
export interface PortEntry {
  port: number;
  /** The app's main checkout. */
  app: string;
  master: string;
  /** The master's app worktree. */
  dir: string;
}

/** The registry file: `<linkedHome()>/master-ports.json`. */
export const portRegistryFile = (): string => path.join(linkedHome(), 'master-ports.json');

/** The registry's entries whose worktree still exists, by port. Never writes. */
export function readPortRegistry(): PortEntry[] {
  return readEntries().filter((e) => fs.existsSync(e.dir));
}

/** Every well-formed entry of the registry, gone worktrees included. */
function readEntries(): PortEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(portRegistryFile(), 'utf8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  const out: PortEntry[] = [];
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const port = Number.parseInt(key, 10);
    if (!Number.isInteger(port) || !v || typeof v !== 'object') continue;
    const {app, master, dir} = v as Record<string, unknown>;
    if (typeof app !== 'string' || typeof master !== 'string' || typeof dir !== 'string') continue;
    out.push({port, app, master, dir});
  }
  return out.sort((a, b) => a.port - b.port);
}

function writePortRegistry(entries: PortEntry[]): void {
  const file = portRegistryFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const body: Record<string, {app: string; master: string; dir: string}> = {};
  for (const e of [...entries].sort((a, b) => a.port - b.port)) body[String(e.port)] = {app: e.app, master: e.master, dir: e.dir};
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Record `entry` in the registry (replacing its port's entry). Call inside the `master-ports` lock. */
export function recordPort(entry: PortEntry): void {
  writePortRegistry([...readPortRegistry().filter((e) => e.port !== entry.port), entry]);
}

/**
 * Drop master `master` of `app` from the registry. Call inside the `master-ports` lock. Writes
 * nothing when the registry does not exist; returns the ports released.
 */
export function releasePort(app: string, master: string): number[] {
  if (!fs.existsSync(portRegistryFile())) return [];
  const mine = (e: PortEntry): boolean => e.app === app && e.master === master;
  // Its worktree is usually gone by now, so it is looked for among every entry.
  const released = readEntries().filter(mine).map((e) => e.port);
  writePortRegistry(readPortRegistry().filter((e) => !mine(e)));
  return released;
}

/** Who holds `port`: one of this app's masters (git config) or the registry; null when free. */
export function portHolder(port: number, masters: Master[], registry: PortEntry[]): {master: string; dir: string} | null {
  const m = masters.find((x) => x.port === port);
  if (m) return {master: m.name, dir: m.dir};
  const e = registry.find((x) => x.port === port);
  return e ? {master: e.master, dir: e.dir} : null;
}

/** The first preview port neither this app's masters nor the machine registry hold; null when all nine are taken. */
export function freeMasterPort(masters: Master[], registry: PortEntry[] = []): number | null {
  return MASTER_PORTS.find((p) => !portHolder(p, masters, registry)) ?? null;
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
