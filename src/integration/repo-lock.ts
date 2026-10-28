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

function acquire(
  gitDir: string,
  what: string,
  options: RepoLockOptions,
): Holder {
  const file = path.join(gitDir, REPO_LOCK_FILE);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPO_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const mine: Holder = {
    pid: process.pid,
    host: os.hostname(),
    at: new Date().toISOString(),
    what,
  };
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine) + '\n', {flag: 'wx'});
      return mine;
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
        continue; // the other run moved it
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
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LocalizeError(
        `${gitDir} is locked by ${describe(holder)}; waited ${Math.round(timeoutMs / 1000)} s for it. ` +
          `Run this again when that run has finished; if no run is working on it, delete ${file}.`,
        EXIT_REFUSED,
      );
    }
    sleep(pollMs);
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
