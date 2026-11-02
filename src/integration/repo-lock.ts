/**
 * One lock per git repository, for the repos several app checkouts share: a package's bare base
 * clone under `<root>/.repos/` is the git dir of that package's worktree in every app that lists
 * it, so two runs for two apps (`linked checkout`, `branch fork`, `branch push`, `branch merge`,
 * `worktree remove --branch`) could fetch, add worktrees or move refs in it at once, and one of
 * them would fail on git's own ref or `index.lock`.
 *
 * The lock is a file `linked.lock` in the repo's git common dir (the base clone itself), created
 * exclusively and holding `{pid, host, at, what}`. A run holds it around its git work on that one
 * repo and never holds two, so runs cannot deadlock. A waiter polls up to `timeoutMs` (default
 * 120 s), then is refused (exit 6) with the holder named. A lock whose holder process is gone (same
 * host) is taken over; one from another host is never broken. A process that holds a lock already
 * re-enters it.
 *
 * `withRepoLockAsync` holds the same lock around an async `fn` until its promise settles. It never
 * re-enters: overlapping calls in one process queue behind each other, so a nested call on the same
 * lock waits for its caller forever. `withMachineLockAsync` is it on a lock under
 * `<linkedHome()>/locks/<name>`, for state one machine's runs share (the masters' preview ports).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {EXIT_REFUSED, LocalizeError} from '../localize/errors.js';
import type {Run} from '../localize/run.js';

export const REPO_LOCK_FILE = 'linked.lock';
export const DEFAULT_REPO_LOCK_TIMEOUT_MS = 120_000;
/** A lock file nobody has finished writing (its writer died in between) is stale after this. */
const UNREADABLE_STALE_MS = 10_000;

export interface RepoLockOptions {
  /** How long to wait for another run's lock; default 120 s. */
  timeoutMs?: number;
  /** How often to look again while waiting; default 200 ms. */
  pollMs?: number;
}

interface Holder {
  pid: number;
  host: string;
  at: string;
  what: string;
}

/** Locks this process holds: git dir → how deep, and the lock file's content. */
const held = new Map<string, {depth: number; mine: Holder}>();

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function readHolder(file: string): Holder | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as Holder).pid === 'number' &&
      typeof (v as Holder).host === 'string'
    )
      return v as Holder;
  } catch {
    /* missing, or not written yet */
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the lock at `file` was left by a run that is gone. */
function isStale(file: string, holder: Holder | null): boolean {
  if (holder) return holder.host === os.hostname() && !alive(holder.pid);
  try {
    return Date.now() - fs.statSync(file).mtimeMs > UNREADABLE_STALE_MS;
  } catch {
    return false; // gone already: the next try takes it
  }
}

const sameHolder = (a: Holder, b: Holder | null): boolean =>
  !!b && a.pid === b.pid && a.host === b.host && a.at === b.at;

const describe = (h: Holder | null): string =>
  h ? `${h.what} (pid ${h.pid} on ${h.host}, since ${h.at})` : 'another run';

function newHolder(what: string): Holder {
  return {pid: process.pid, host: os.hostname(), at: new Date().toISOString(), what};
}

/**
 * One try at the lock file `file`: true when `mine` now holds it. A stale lock is moved aside
 * (the caller tries again at once); `{holder}` names the live holder to wait for.
 */
function tryAcquire(file: string, mine: Holder): true | {holder: Holder | null; retry: boolean} {
  try {
    fs.writeFileSync(file, JSON.stringify(mine) + '\n', {flag: 'wx'});
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const holder = readHolder(file);
  if (isStale(file, holder)) {
    // Moved aside first: of two runs that both found it stale, only one moves it.
    const aside = `${file}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      return {holder, retry: true}; // the other run moved it
    }
    const moved = readHolder(aside);
    if (moved && !sameHolder(moved, holder)) {
      // A run took it over between the read and the move: give it back.
      try {
        fs.linkSync(aside, file);
      } catch {
        /* taken again meanwhile */
      }
    }
    fs.rmSync(aside, {force: true});
    return {holder, retry: true};
  }
  return {holder, retry: false};
}

function timedOut(gitDir: string, file: string, holder: Holder | null, timeoutMs: number): LocalizeError {
  return new LocalizeError(
    `${gitDir} is locked by ${describe(holder)}; waited ${Math.round(timeoutMs / 1000)} s for it. ` +
      `Run this again when that run has finished; if no run is working on it, delete ${file}.`,
    EXIT_REFUSED,
  );
}

function acquire(
  gitDir: string,
  what: string,
  options: RepoLockOptions,
): Holder {
  const file = path.join(gitDir, REPO_LOCK_FILE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPO_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const mine = newHolder(what);
  for (;;) {
    const r = tryAcquire(file, mine);
    if (r === true) return mine;
    if (r.retry) continue;
    if (Date.now() >= deadline) throw timedOut(gitDir, file, r.holder, timeoutMs);
    sleep(pollMs);
  }
}

async function acquireAsync(gitDir: string, what: string, options: RepoLockOptions): Promise<Holder> {
  const file = path.join(gitDir, REPO_LOCK_FILE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPO_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const mine = newHolder(what);
  for (;;) {
    const r = tryAcquire(file, mine);
    if (r === true) return mine;
    if (r.retry) continue;
    if (Date.now() >= deadline) throw timedOut(gitDir, file, r.holder, timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Run `fn` holding the lock of the repository whose git common dir is `gitDir` (a bare base
 * clone's own directory). Waits for another run's lock (see the module header); `what` names
 * this run in the lock file, for a waiter's message.
 */
export function withRepoLock<T>(
  gitDir: string,
  what: string,
  fn: () => T,
  options: RepoLockOptions = {},
): T {
  const key = path.resolve(gitDir);
  const entry = held.get(key) ?? {depth: 0, mine: acquire(key, what, options)};
  entry.depth++;
  held.set(key, entry);
  try {
    return fn();
  } finally {
    if (--entry.depth === 0) {
      held.delete(key);
      const file = path.join(key, REPO_LOCK_FILE);
      // Only our own: a lock taken over from us (we looked dead) is the new holder's.
      if (sameHolder(entry.mine, readHolder(file)))
        fs.rmSync(file, {force: true});
    }
  }
}

/** The git common dir of the checkout at `dir` (for a base clone's worktree: the base clone), or null. */
export function commonDirOf(run: Run, dir: string): string | null {
  const r = run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      cwd: dir,
    },
  );
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : null;
}

/** {@link withRepoLock} for the repository of the checkout at `dir`; no lock when it is not one. */
export function withCheckoutLock<T>(
  run: Run,
  dir: string,
  what: string,
  fn: () => T,
  options: RepoLockOptions = {},
): T {
  const gitDir = commonDirOf(run, dir);
  return gitDir ? withRepoLock(gitDir, what, fn, options) : fn();
}

/** Async holders in this process, by lock dir: each call waits for the one before it. */
const asyncTails = new Map<string, Promise<void>>();

/**
 * {@link withRepoLock} for an async `fn`: the lock is held until `fn`'s promise settles. Waiting
 * uses timers, never blocks the event loop, and is not re-entrant (see the module header).
 */
export async function withRepoLockAsync<T>(
  gitDir: string,
  what: string,
  fn: () => Promise<T>,
  options: RepoLockOptions = {},
): Promise<T> {
  const key = path.resolve(gitDir);
  const before = asyncTails.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => (done = resolve));
  const tail = before.then(() => mine);
  asyncTails.set(key, tail);
  try {
    await before;
    const holder = await acquireAsync(key, what, options);
    try {
      return await fn();
    } finally {
      const file = path.join(key, REPO_LOCK_FILE);
      if (sameHolder(holder, readHolder(file))) fs.rmSync(file, {force: true});
    }
  } finally {
    done();
    if (asyncTails.get(key) === tail) asyncTails.delete(key);
  }
}

/** The directory linked keeps machine-wide state in: `$LINKED_HOME`, else `~/.linked`. */
export function linkedHome(): string {
  return process.env.LINKED_HOME ?? path.join(os.homedir(), '.linked');
}

/** {@link withRepoLockAsync} on the machine-wide lock `<linkedHome()>/locks/<name>`, made on demand. */
export async function withMachineLockAsync<T>(
  name: string,
  what: string,
  fn: () => Promise<T>,
  options: RepoLockOptions = {},
): Promise<T> {
  const dir = path.join(linkedHome(), 'locks', name);
  fs.mkdirSync(dir, {recursive: true});
  return withRepoLockAsync(dir, what, fn, options);
}
