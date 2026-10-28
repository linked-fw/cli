/**
 * The rules `linked checkout` and `linked localize --listed` share: the transitive walk over
 * `linked.unpublishedPackages`, which branch each repo is checked out on, and the directory name
 * of a branch.
 */
import {EXIT_REFUSED, LocalizeError} from '../localize/errors.js';
import {
  unpublishedPackages,
  type UnpublishedPackage,
} from '../installed-packages.js';

/** A package the walk reached: its list entry and every package that lists it. */
export interface ListedPackage extends UnpublishedPackage {
  /** The npm names whose lists name it, the app first, in the order they were reached. */
  requiredBy: string[];
}

/**
 * Makes `entry` available (clones it, adds its worktree, or finds it already there) and returns
 * its `package.json`, whose own list the walk follows; null when it has none to read.
 */
export type LoadListed = (entry: ListedPackage) => unknown;

/**
 * Breadth first from `root` (the app's `package.json`): each package of its list, then of theirs.
 * Keyed by npm name: a name listed again with the same repo is loaded once and gains a
 * `requiredBy`; listed with another repo it refuses (code 6), naming both requirers, before the
 * second is loaded. Cycles end at the names already seen. `load` runs once per package, in walk
 * order, so a refusal leaves only what the earlier calls made.
 */
export function walkUnpublished(
  root: unknown,
  load: LoadListed,
  warn: (message: string) => void = () => {},
): ListedPackage[] {
  const rootName = nameOf(root) ?? 'the app';
  const seen = new Map<string, ListedPackage>();
  const queue: {from: string; entries: UnpublishedPackage[]}[] = [
    {from: rootName, entries: unpublishedPackages(root, warn)},
  ];
  while (queue.length) {
    const {from, entries} = queue.shift()!;
    for (const entry of entries) {
      const known = seen.get(entry.name);
      if (known) {
        if (known.repo !== entry.repo) {
          throw new LocalizeError(
            `${entry.name} is listed with two repos: ${known.repo} (by ${known.requiredBy.join(', ')}) ` +
              `and ${entry.repo} (by ${from}). Make the lists agree; nothing was installed.`,
            EXIT_REFUSED,
          );
        }
        if (!known.requiredBy.includes(from)) known.requiredBy.push(from);
        continue;
      }
      const listed: ListedPackage = {...entry, requiredBy: [from]};
      seen.set(entry.name, listed);
      const json = load(listed);
      if (json)
        queue.push({
          from: entry.name,
          entries: unpublishedPackages(json, warn),
        });
    }
  }
  return [...seen.values()];
}

function nameOf(json: unknown): string | undefined {
  const name =
    json && typeof json === 'object'
      ? (json as {name?: unknown}).name
      : undefined;
  return typeof name === 'string' ? name : undefined;
}

/** How a package repo is checked out for `branch`. */
export type PackageBranch =
  | {on: 'branch'; branch: string; fellBack: false}
  | {on: 'default'; branch: string; fellBack: true};

/**
 * THE branch rule for a package: `branch` when its repo has `origin/<branch>`, else its default
 * branch (`fellBack`). A worktree takes the fallback detached at `origin/<default>` (two branch
 * checkouts that both fall back would otherwise both need the default branch checked out, which
 * git refuses); a full clone (`localize --listed`) stays on its default branch.
 */
export function packageBranch(
  branch: string | null,
  hasRemoteBranch: boolean,
  defaultBranch: string,
): PackageBranch {
  if (branch && hasRemoteBranch) return {on: 'branch', branch, fellBack: false};
  return {on: 'default', branch: defaultBranch, fellBack: true};
}

/** How the app repo is checked out for `branch`: on it when the remote has it, else created from `from`. */
export type AppBranch = {create: false} | {create: true; from: string};

export function appBranch(hasRemoteBranch: boolean, from: string): AppBranch {
  return hasRemoteBranch ? {create: false} : {create: true, from};
}

/** The directory name for `branch`: `/` becomes `__` (`feat/x` -> `feat__x`). */
export function branchDir(branch: string): string {
  return branch.replace(/\//g, '__');
}
