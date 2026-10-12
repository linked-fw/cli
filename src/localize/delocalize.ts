/**
 * `delocalize` -- go back to the registry copy WITHOUT losing work.
 *
 * A checkout is parked: moved to `.packages-local.parked/<dir>`, outside the
 * `packages-local/*` glob, so npm installs the registry copy again and
 * `linked localize <name>` (or `--parked`) takes it back as it was. With no
 * names, every checkout is parked.
 *
 * Then the install that swaps the links for registry copies:
 *
 * - no checkout left: `npm ci`, which installs exactly the committed lockfile;
 * - some left: `npm install` (`npm ci` refuses a lockfile that lists members
 *   it does not), then `npm rebuild <names>` -- an install that replaces a
 *   link with the registry copy leaves that package's bin without its execute
 *   bit (measured), and a rebuild relinks it.
 *
 * `--purge` deletes the checkout instead of parking it, and refuses on
 * uncommitted changes or unpushed commits unless `--force`.
 */
import fs from 'node:fs';
import path from 'node:path';

import {EXIT_INSTALL_FAILED, EXIT_WARNED} from './errors.js';
import {checkoutRepoRoot, existsOrLink, isInside, isSymlink, moveEntry} from './fsops.js';
import {INSTALL_ARGS, legacyManifestHint, tail} from './localize.js';
import {
  LOCAL_DIR,
  PARKED_DIR,
  localMembers,
  parkedMembers,
} from './members.js';
import type {Member} from './members.js';
import type {Deps} from './run.js';

export function delocalize(
  names: string[],
  opts: {purge?: boolean; force?: boolean},
  deps: Deps,
): number {
  legacyManifestHint(deps);
  const members = localMembers(deps.appRoot);
  let code = 0;
  const targets: Member[] = [];
  for (const name of names.length ? names : members.map((m) => m.name)) {
    const member = findMember(name, members);
    if (member) {
      targets.push(member);
      continue;
    }
    const parked = findMember(name, parkedMembers(deps.appRoot));
    deps.warn(
      parked
        ? `[localize] ${parked.name} is already parked in ${parked.dir}.`
        : `[localize] ${name} is not localized -- nothing in ${LOCAL_DIR}/ is named that.`,
    );
    code = Math.max(code, EXIT_WARNED);
  }

  const done: string[] = [];
  for (const member of targets) {
    const result = opts.purge
      ? purge(member, opts, deps)
      : park(member, deps);
    if (result === 'done') done.push(member.name);
    else code = Math.max(code, EXIT_WARNED);
  }
  if (!done.length) return code;
  return Math.max(code, reinstall(done, deps));
}

function park(member: Member, deps: Deps): 'done' | 'refused' {
  const to = `${PARKED_DIR}/${path.basename(member.dir)}`;
  if (existsOrLink(path.join(deps.appRoot, to))) {
    deps.warn(
      `[localize] ${member.name}: ${to} already exists, so ${member.dir} was not parked. Move ` +
        `one of them out of the way.`,
    );
    return 'refused';
  }
  moveEntry(path.join(deps.appRoot, member.dir), path.join(deps.appRoot, to));
  deps.log(
    `[localize] parked ${member.name}: ${member.dir} -> ${to} (\`linked localize ${member.name}\` takes it back)`,
  );
  return 'done';
}

function purge(
  member: Member,
  opts: {force?: boolean},
  deps: Deps,
): 'done' | 'refused' {
  const entry = path.join(deps.appRoot, member.dir);
  const repo = checkoutRepoRoot(entry, deps.appRoot);
  const refusal = repo ? purgeRefusal(repo, deps) : null;
  if (refusal && !opts.force) {
    deps.warn(
      `[localize] ${member.dir}: not deleting -- ${refusal}. Pass --force to delete it anyway.`,
    );
    return 'refused';
  }
  if (refusal)
    deps.warn(`[localize] --force: deleting ${member.dir} despite ${refusal}`);

  if (isSymlink(entry)) {
    // A package inside a cloned monorepo: the clone goes too, unless another
    // checkout or parked checkout still links into it.
    fs.unlinkSync(entry);
    if (repo && !linkedFromElsewhere(repo, deps)) {
      fs.rmSync(repo, {recursive: true, force: true});
      deps.log(
        `[localize] removed ${member.dir} and ${path.relative(deps.appRoot, repo)}`,
      );
      return 'done';
    }
  } else {
    fs.rmSync(entry, {recursive: true, force: true});
  }
  deps.log(`[localize] removed ${member.dir}`);
  return 'done';
}

/** Does any remaining checkout, here or parked, live inside `repo`? */
function linkedFromElsewhere(repo: string, deps: Deps): boolean {
  return [...localMembers(deps.appRoot), ...parkedMembers(deps.appRoot)].some(
    (m) => {
      try {
        return isInside(fs.realpathSync(path.join(deps.appRoot, m.dir)), repo);
      } catch {
        return false;
      }
    },
  );
}

/** The install after parking or purging: see the module header. */
function reinstall(names: string[], deps: Deps): number {
  const remaining = localMembers(deps.appRoot).length;
  const args = remaining ? INSTALL_ARGS : ['ci', '--no-audit', '--no-fund'];
  deps.log(`[localize] npm ${args.join(' ')} (app root)`);
  const r = deps.run('npm', args, {cwd: deps.appRoot});
  if (r.status !== 0) {
    deps.error(
      `[localize] npm ${args[0]} failed at the app root; node_modules may still link the ` +
        `checkout${names.length === 1 ? '' : 's'}. Fix the cause and run \`npm install\`.\n` +
        tail(r.stderr || r.stdout),
    );
    return EXIT_INSTALL_FAILED;
  }
  if (!remaining) return 0;
  const rebuild = deps.run('npm', ['rebuild', ...names], {cwd: deps.appRoot});
  if (rebuild.status !== 0) {
    deps.warn(
      `[localize] npm rebuild ${names.join(' ')} failed; a registry copy's bin may not be ` +
        `executable until it runs.\n${tail(rebuild.stderr || rebuild.stdout)}`,
    );
    return EXIT_WARNED;
  }
  return 0;
}

/** @returns the reason a purge must be refused, or null. */
function purgeRefusal(repo: string, deps: Deps): string | null {
  const status = deps.run('git', ['status', '--porcelain'], {cwd: repo});
  if (status.stdout.trim()) {
    const n = status.stdout.split('\n').filter((l) => l.trim()).length;
    return `it has ${n} uncommitted change${n === 1 ? '' : 's'}`;
  }
  // `@{u}` fails without an upstream; then every branch's commits not on any remote count.
  const upstream = deps.run('git', ['log', '--oneline', '@{u}..HEAD'], {
    cwd: repo,
  });
  const unpushed =
    upstream.status === 0
      ? upstream
      : deps.run('git', ['log', '--oneline', '--branches', '--not', '--remotes'], {
          cwd: repo,
        });
  if (unpushed.status === 0 && unpushed.stdout.trim()) {
    const n = unpushed.stdout.split('\n').filter((l) => l.trim()).length;
    return `it has ${n} unpushed commit${n === 1 ? '' : 's'}`;
  }
  return null;
}

/** By full name, or by the part after the scope when that is unambiguous. */
function findMember(name: string, members: Member[]): Member | undefined {
  const exact = members.find((m) => m.name === name);
  if (exact) return exact;
  const short = members.filter((m) => m.name.split('/').pop() === name);
  return short.length === 1 ? short[0] : undefined;
}
