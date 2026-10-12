/**
 * `localize` -- turn an npm-installed dependency into an editable git checkout
 * that npm itself links.
 *
 * A checkout in `packages-local/` is a workspace member: the app's
 * `workspaces` holds `"packages-local/*"`, so `npm install` links
 * `node_modules/<name>` to it and dedupes everything below it like any other
 * member. The committed `package-lock.json` is put back after every install by
 * `hooks/lock-at-rest.cjs`, so the working tree stays clean.
 *
 * One run, for every name at once:
 *
 *   1. refuse an `overrides` key naming a package being localized or already
 *      in `packages-local/` (npm fails with `EOVERRIDE` on a member's name);
 *      nothing is changed then;
 *   2. the one-time app setup (app-setup.ts), reported line by line so the
 *      developer commits it; when it changed `package.json`, the lockfile
 *      that goes with it is made now, before anything is cloned, and written
 *      back after the install (`captureSetupLockfile`);
 *   3. per name: a parked checkout (`linked delocalize`) moves back; an
 *      existing directory is refused with an `--adopt` hint; anything else is
 *      resolved through the registry's `repository` (or `--repo`) and cloned;
 *   4. the git hooks (git-hooks.ts), or the lines to add under
 *      `core.hooksPath`;
 *   5. ONE `npm install` at the app root -- a checkout's dependencies arrive
 *      with it, so it comes before any build;
 *   6. build each new checkout: `--build`, else `linked build`, else for the
 *      cli its own `npm run build` (the cli is what `linked build` runs, and a
 *      fresh cli checkout has no `lib/` yet). The cli builds first and then
 *      gets its bin linked (`npm rebuild`), since the others' `linked build`
 *      runs it. A failing build warns: a package whose build is broken is
 *      usually what you localized it to fix.
 *
 * `adopt` (adopt.ts) replaces step 3 with "the checkout is already there", and
 * `--parked` with "every parked checkout". Steps 1, 2 and 4-6 are `runLocalize`.
 *
 * A package inside a monorepo (`--subdir`, or a registry `repository.directory`)
 * is cloned whole into `packages-local/.repos/<checkout>` -- a dot directory,
 * which the `packages-local/*` glob skips -- and `packages-local/<checkout>` is
 * a link to the package inside it. npm follows the link like a directory.
 */
import fs from 'node:fs';
import path from 'node:path';

import {conflictingOverrides, ensureAppSetup} from './app-setup.js';
import type {SetupChange} from './app-setup.js';
import {describeDrift, driftProblems} from './drift.js';
import {
  EXIT_INSTALL_FAILED,
  EXIT_REFUSED,
  EXIT_USAGE,
  EXIT_WARNED,
  LocalizeError,
} from './errors.js';
import {existsOrLink, moveEntry, readJson} from './fsops.js';
import {installGitHooks} from './git-hooks.js';
import type {HookInstall} from './git-hooks.js';
import {LOCAL_DIR, localMembers, parkedMembers, PARKED_DIR} from './members.js';
import type {Member} from './members.js';
import {checkoutNameFor, resolvePackage} from './resolve.js';
import type {Deps, RunResult} from './run.js';

/** What a new checkout is built with when `--build` does not say. */
export const DEFAULT_BUILD_COMMAND = 'linked build';
/** The cli builds itself: `linked build` IS the cli, and a fresh checkout of it has no `lib/`. */
export const CLI_PACKAGE = '@_linked/cli';
export const CLI_BUILD_COMMAND = 'npm run build';
/** The one install a run makes, at the app root. */
export const INSTALL_ARGS = ['install', '--no-audit', '--no-fund'];
/** Where a cloned monorepo lives, inside `packages-local/` but outside its glob. */
export const REPOS_DIR = `${LOCAL_DIR}/.repos`;
/** The app's lockfile, kept clean of checkouts. */
export const LOCKFILE = 'package-lock.json';
/** What an app recorded checkouts in before they were workspace members. */
export const LEGACY_MANIFEST = 'local-packages.json';

export interface LocalizeOptions {
  /** Where checkouts live. Only `packages-local` is accepted: the workspace glob names it. */
  dir?: string;
  repo?: string;
  subdir?: string;
  /** Run in each new checkout after the install. Absent: the default; empty: no build. */
  build?: string;
}

/** A checkout ready for the install. */
export interface Prepared {
  name: string;
  /** App-relative, `/`-separated: `packages-local/_linked-core`. */
  dir: string;
  /** Build it after the install: a new clone or an adopted checkout, not a returning parked one. */
  build: boolean;
}

/** How one name becomes a checkout in `packages-local/`; null when there is nothing to do. */
export type Prepare = (
  name: string,
  opts: LocalizeOptions,
  deps: Deps,
) => Prepared | null;

/**
 * @param names  full npm package names
 * @returns the process exit code: the highest of the per-name codes and the
 *   install's, since a failure on name 2 does not undo name 1.
 */
export function localize(
  names: string[],
  opts: LocalizeOptions,
  deps: Deps,
): number {
  return runLocalize(names, opts, deps, prepareClone);
}

/**
 * The run `localize`, `adopt` and `--parked` share: everything except how a
 * name becomes a checkout. See the module header for the steps.
 */
export function runLocalize(
  names: string[],
  opts: LocalizeOptions,
  deps: Deps,
  prepare: Prepare,
): number {
  legacyManifestHint(deps);
  let setupLock: string | undefined;
  try {
    checkDir(opts.dir);
    // The checkouts already there count too: the one install below covers them all.
    const localized = new Set([
      ...names,
      ...localMembers(deps.appRoot).map((m) => m.name),
    ]);
    const conflicts = conflictingOverrides(deps.appRoot, [...localized]);
    if (conflicts.length) {
      throw new LocalizeError(
        `package.json "overrides" names a localized package: ${conflicts
          .map((k) => `"${k}"`)
          .join(', ')}.\n` +
          `npm refuses an override on a workspace member's name (EOVERRIDE), and a nested one ` +
          `would replace the checkout. Remove ${conflicts.length === 1 ? 'that key' : 'those keys'} ` +
          `from "overrides", then run this again. Nothing was changed.`,
        EXIT_REFUSED,
      );
    }
    const changes = ensureAppSetup(deps.appRoot);
    reportSetup(changes, deps);
    if (changes.some((c) => c.file === 'package.json'))
      setupLock = captureSetupLockfile(changes, deps) ?? undefined;
  } catch (e) {
    return reportError(e, deps);
  }

  let code = 0;
  const prepared: Prepared[] = [];
  for (const name of names) {
    try {
      const p = prepare(name, opts, deps);
      if (p) prepared.push(p);
    } catch (e) {
      code = Math.max(code, reportError(e, deps));
    }
  }
  if (!prepared.length) {
    // Nothing was installed: the work tree holds the set-up's lockfile as captured.
    if (setupLock !== undefined) commitHint(deps);
    return code;
  }
  return Math.max(code, installAndBuild(prepared, opts, deps, setupLock));
}

/**
 * Steps 4-6: git hooks, one root install, then the builds. `setupLock` is the
 * lockfile the set-up captured (see `captureSetupLockfile`), written back
 * over what the install left.
 */
export function installAndBuild(
  prepared: Prepared[],
  opts: Pick<LocalizeOptions, 'build'>,
  deps: Deps,
  setupLock?: string,
): number {
  reportHooks(installGitHooks(deps.appRoot), deps);

  deps.log(`[localize] npm ${INSTALL_ARGS.join(' ')} (app root)`);
  const install = deps.run('npm', INSTALL_ARGS, {cwd: deps.appRoot});
  if (setupLock !== undefined) restoreSetupLockfile(setupLock, deps);
  if (install.status !== 0) {
    deps.error(
      `[localize] npm install failed at the app root. The checkout${prepared.length === 1 ? ' stays' : 's stay'} ` +
        `in ${LOCAL_DIR}/; fix the cause and run \`npm install\`.\n` +
        tail(install.stderr || install.stdout),
    );
    return EXIT_INSTALL_FAILED;
  }

  let code = 0;
  // The cli first: the other builds run `linked build`, which is the cli.
  const ordered = [
    ...prepared.filter((p) => p.name === CLI_PACKAGE),
    ...prepared.filter((p) => p.name !== CLI_PACKAGE),
  ];
  for (const p of ordered) {
    const pkgDir = path.join(deps.appRoot, p.dir);
    const built = p.build ? runBuild(p, pkgDir, opts, deps) : 'skipped';
    if (built === 'failed') code = EXIT_WARNED;
    if (built === 'ok' && p.name === CLI_PACKAGE) linkCliBin(deps);
    deps.log(
      `[localize] ${p.name} -> ${p.dir} (branch ${currentBranch(pkgDir, deps)})`,
    );
  }
  for (const d of driftProblems(deps.appRoot))
    deps.warn(`[localize] drift: ${describeDrift(d)}`);
  return code;
}

/**
 * npm links a package's bin only when its target exists, and a fresh cli
 * checkout has no `lib/` at install time: without this, `node_modules/.bin/linked`
 * is missing after the build, and `npx linked` would fetch the unrelated npm
 * package named `linked`. `--ignore-scripts`: only the bin links are wanted.
 */
function linkCliBin(deps: Deps): void {
  const r = deps.run('npm', ['rebuild', CLI_PACKAGE, '--ignore-scripts'], {
    cwd: deps.appRoot,
  });
  if (r.status !== 0) {
    deps.warn(
      `[localize] npm rebuild ${CLI_PACKAGE} failed, so \`linked\` may not be on the app's ` +
        `bin path. Run it yourself.\n` +
        tail(r.stderr || r.stdout),
    );
  }
}

/** Step 3 for `localize`: take back a parked checkout, else clone. */
function prepareClone(
  name: string,
  opts: LocalizeOptions,
  deps: Deps,
): Prepared | null {
  const parked = parkedMembers(deps.appRoot).find((m) => m.name === name);
  if (parked) return unpark(parked, deps);

  const member = localMembers(deps.appRoot).find((m) => m.name === name);
  if (member) {
    throw new LocalizeError(
      `${name} is already in ${member.dir}. To install and build it as it is:\n` +
        `  linked localize ${name} --adopt`,
      EXIT_REFUSED,
    );
  }

  const relDir = `${LOCAL_DIR}/${checkoutNameFor(name)}`;
  const target = path.join(deps.appRoot, relDir);
  if (existsOrLink(target)) {
    throw new LocalizeError(
      `${relDir} already exists. localize never clones over a directory. If it is ${name}'s ` +
        `checkout, install and build it as it is:\n  linked localize ${name} --adopt`,
      EXIT_REFUSED,
    );
  }

  const resolved = resolvePackage(
    name,
    deps,
    opts.repo ? {repo: opts.repo, subdir: opts.subdir} : undefined,
  );

  // A monorepo is cloned whole outside the glob; the member is a link to the package.
  const relClone = resolved.subdir
    ? `${REPOS_DIR}/${checkoutNameFor(name)}`
    : relDir;
  const clone = path.join(deps.appRoot, relClone);
  if (existsOrLink(clone)) {
    throw new LocalizeError(
      `${relClone} already exists. Remove it, or move it out of the way, and run this again.`,
      EXIT_REFUSED,
    );
  }
  fs.mkdirSync(path.dirname(clone), {recursive: true});
  deps.log(`[localize] cloning ${resolved.repo} -> ${relClone}`);
  const r = deps.run('git', ['clone', resolved.repo, clone]);
  if (r.status !== 0) {
    throw new LocalizeError(
      `git clone ${resolved.repo} failed:\n${(r.stderr || r.stdout).trim()}`,
      EXIT_REFUSED,
    );
  }

  const pkgDir = resolved.subdir ? path.join(clone, resolved.subdir) : clone;
  const relPkg = resolved.subdir ? `${relClone}/${resolved.subdir}` : relClone;
  // A clone that is not the package must not stay: in packages-local/ it
  // would be a workspace member under the wrong name.
  const declared = readJson(path.join(pkgDir, 'package.json'))?.name;
  if (declared !== name) {
    fs.rmSync(clone, {recursive: true, force: true});
    const where = resolved.subdir
      ? `The registry's repository.directory for "${name}" points at the wrong place.`
      : `${resolved.repo} looks like a monorepo. Say where the package lives:\n` +
        `  linked localize ${name} --repo ${resolved.repo} --subdir <path-inside-the-repo>`;
    throw new LocalizeError(
      (declared
        ? `${relPkg} declares itself as "${declared}", not "${name}".\n`
        : `${relPkg} has no package.json naming it, so it is not the package "${name}".\n`) +
        `${where}\nThe clone was removed.`,
      EXIT_REFUSED,
    );
  }

  if (resolved.subdir) {
    fs.symlinkSync(path.relative(path.dirname(target), pkgDir), target, 'dir');
    deps.log(`[localize] ${relDir} -> ${relPkg}`);
  }
  return {name, dir: relDir, build: true};
}

/** Move a parked checkout back into `packages-local/`. No clone, no build: it is as it was. */
export function unpark(member: Member, deps: Deps): Prepared {
  const entry = path.basename(member.dir);
  const relDir = `${LOCAL_DIR}/${entry}`;
  const to = path.join(deps.appRoot, relDir);
  if (existsOrLink(to)) {
    throw new LocalizeError(
      `${member.name} is parked in ${member.dir}, but ${relDir} already exists. Move one of ` +
        `them out of the way and run this again.`,
      EXIT_REFUSED,
    );
  }
  moveEntry(path.join(deps.appRoot, member.dir), to);
  deps.log(`[localize] ${member.dir} -> ${relDir}`);
  return {name: member.name, dir: relDir, build: false};
}

/** `--dir` is kept for scripts that pass the default; anything else is not a workspace member. */
function checkDir(dir: string | undefined): void {
  if (dir === undefined || dir.replace(/\/+$/, '') === LOCAL_DIR) return;
  throw new LocalizeError(
    `--dir ${dir}: checkouts live in ${LOCAL_DIR}/, the directory the app's ` +
      `"workspaces" glob and the lock-at-rest hook name. Move them there.`,
    EXIT_USAGE,
  );
}

function reportSetup(changes: SetupChange[], deps: Deps): void {
  if (!changes.length) return;
  deps.log(`[localize] set up this app for checkouts (commit these):`);
  for (const c of changes) deps.log(`  ${c.file}: ${c.what}`);
}

/** What `captureSetupLockfile` runs: the lockfile for the new `package.json`, nothing installed. */
export const SETUP_LOCK_ARGS = [
  'install',
  '--package-lock-only',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
];

/**
 * The set-up changed `package.json`, so the lockfile must change with it
 * (the root entry's `workspaces`) -- and it must be a lockfile with no
 * checkout in it, which the install below cannot give: it lists them, and
 * lock-at-rest leaves it so while `package.json` differs from HEAD. So,
 * before anything is cloned, ask npm for the lockfile alone, keep it, and
 * write it back after the install. Checkouts already in `packages-local/` (an
 * adopted one) are moved aside for that one call.
 *
 * @returns the lockfile to write back, or null when it could not be made (the
 *   manual steps are printed instead).
 */
function captureSetupLockfile(
  changes: SetupChange[],
  deps: Deps,
): string | null {
  const local = path.join(deps.appRoot, LOCAL_DIR);
  const aside = path.join(deps.appRoot, `.${LOCAL_DIR}.setup`);
  const lockfile = path.join(deps.appRoot, LOCKFILE);
  const moveAside = localMembers(deps.appRoot).length > 0;
  if (moveAside && existsOrLink(aside)) {
    manualSetupSteps(changes, `${path.basename(aside)}/ is in the way`, deps);
    return null;
  }
  deps.log(`[localize] npm ${SETUP_LOCK_ARGS.join(' ')} (the set-up's lockfile)`);
  if (moveAside) fs.renameSync(local, aside);
  let r: RunResult;
  try {
    r = deps.run('npm', SETUP_LOCK_ARGS, {cwd: deps.appRoot});
  } finally {
    if (moveAside) fs.renameSync(aside, local);
  }
  let text: string | null = null;
  try {
    text = fs.readFileSync(lockfile, 'utf8');
  } catch {
    /* none written */
  }
  if (r.status !== 0 || text === null) {
    manualSetupSteps(
      changes,
      r.status !== 0
        ? `npm could not write it:\n${tail(r.stderr || r.stdout)}`
        : `npm wrote no ${LOCKFILE}`,
      deps,
    );
    return null;
  }
  return text;
}

/** Put the captured set-up lockfile back after the install rewrote it. */
function restoreSetupLockfile(text: string, deps: Deps): void {
  fs.writeFileSync(path.join(deps.appRoot, LOCKFILE), text);
  deps.log(
    `[localize] ${LOCKFILE}: put back the set-up's lockfile, which lists no checkout (any ` +
      `lock-at-rest warning above was about the one the install wrote).`,
  );
  commitHint(deps);
}

function commitHint(deps: Deps): void {
  deps.log(
    `[localize] commit the set-up now -- package.json, ${LOCKFILE}, .gitignore:\n` +
      `  git add package.json ${LOCKFILE} .gitignore && git commit -m "chore: set up linked localize"`,
  );
}

/** The set-up's lockfile could not be made in one step: how to make it by hand. */
function manualSetupSteps(
  changes: SetupChange[],
  why: string,
  deps: Deps,
): void {
  const files = [...new Set([...changes.map((c) => c.file), LOCKFILE])];
  deps.warn(
    `[localize] could not make the set-up's ${LOCKFILE} in one step: ${why}\n` +
      `Commit the set-up with a lockfile from an install with no checkout present:\n` +
      `  npx linked delocalize\n` +
      `  npm install\n` +
      `  git add ${files.join(' ')} && git commit -m "chore: set up linked localize"\n` +
      `  npx linked localize --parked`,
  );
}

/** Tell the developer what `installGitHooks` did not do. */
function reportHooks(hooks: HookInstall, deps: Deps): void {
  for (const file of hooks.skipped) {
    deps.warn(
      `[localize] ${path.relative(deps.appRoot, file)} is not ours, so it was left alone. Without ` +
        `the localize hook there, run \`npm install\` yourself after a pull or branch switch that ` +
        `changes dependencies.`,
    );
  }
  if (hooks.hooksPath !== null) {
    deps.warn(
      `[localize] core.hooksPath is set (${hooks.hooksPath}), so no git hooks were written. Add ` +
        `each line below to the hook named before it (they do nothing where the cli is not ` +
        `installed):`,
    );
    for (const m of hooks.manual) deps.warn(`  ${m.file}:\n    ${m.line}`);
  }
  if (hooks.sharedWithWorktrees) {
    deps.warn(
      `[localize] this is a linked worktree: git hooks are shared by every worktree of the ` +
        `repository. They act only in a work tree whose ${LOCAL_DIR}/ has checkouts.`,
    );
  }
}

/**
 * One line when an app still has the retired record. It is ignored: the
 * record now is the directories in `packages-local/`.
 */
export function legacyManifestHint(deps: Pick<Deps, 'appRoot' | 'warn'>): void {
  if (!fs.existsSync(path.join(deps.appRoot, LEGACY_MANIFEST))) return;
  deps.warn(
    `[localize] ${LEGACY_MANIFEST} is no longer read: every directory in ${LOCAL_DIR}/ is ` +
      `localized, ${PARKED_DIR}/ holds parked ones. Delete the file.`,
  );
}

/**
 * Run the build for one new checkout. `opts.build` wins, including `''` for
 * no build; otherwise the cli builds itself and everything else gets
 * `linked build`.
 */
function runBuild(
  p: Prepared,
  pkgDir: string,
  opts: Pick<LocalizeOptions, 'build'>,
  deps: Deps,
): 'skipped' | 'ok' | 'failed' {
  const cmd = buildCommandFor(p.name, opts);
  if (!cmd) return 'skipped';
  deps.log(`[localize] ${p.dir}: ${cmd}`);
  const r = deps.run(cmd, [], {cwd: pkgDir, shell: true});
  if (r.status !== 0) {
    deps.warn(
      `[localize] ${p.dir}: \`${cmd}\` failed. It is installed and linked anyway -- a package ` +
        `whose build is broken is usually what you localized it to fix.\n` +
        tail(r.stderr || r.stdout),
    );
    return 'failed';
  }
  return 'ok';
}

export function buildCommandFor(
  name: string,
  opts: Pick<LocalizeOptions, 'build'>,
): string {
  if (opts.build !== undefined) return opts.build;
  return name === CLI_PACKAGE ? CLI_BUILD_COMMAND : DEFAULT_BUILD_COMMAND;
}

export function reportError(e: unknown, deps: Pick<Deps, 'error'>): number {
  if (e instanceof LocalizeError) {
    deps.error(`[localize] ${e.message}`);
    return e.code;
  }
  throw e;
}

/**
 * The checked-out branch, or `HEAD` when detached. `symbolic-ref` first,
 * because it also names the branch of a repository with no commits yet --
 * `rev-parse --abbrev-ref` fails there, and `create-package` adopts a fresh
 * `git init` before its first commit.
 */
export function currentBranch(checkout: string, deps: Pick<Deps, 'run'>): string {
  const sym = deps.run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd: checkout,
  });
  if (sym.status === 0 && sym.stdout.trim()) return sym.stdout.trim();
  const r = deps.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: checkout,
  });
  const b = r.stdout.trim();
  return r.status === 0 && b ? b : 'HEAD';
}

/** The last lines of a subprocess's output: enough to see the error, not the whole log. */
export function tail(output: string, lines = 20): string {
  return output.trim().split('\n').slice(-lines).join('\n');
}
