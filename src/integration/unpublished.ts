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
 * Only the root list's `branch` keys are kept: a key in a package's list is dropped with one
 * warning (the app's list decides which package branch the app uses).
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
  const queue: {from: string; fromRoot: boolean; entries: UnpublishedPackage[]}[] = [
    {from: rootName, fromRoot: true, entries: unpublishedPackages(root, warn)},
  ];
  while (queue.length) {
    const {from, fromRoot, entries} = queue.shift()!;
    for (const keyed of entries) {
      let entry = keyed;
      if (!fromRoot && keyed.branch !== undefined) {
        warn(
          `${from}'s list names branch ${keyed.branch} for ${keyed.name}; ignored, the app's list decides.`,
        );
        entry = {name: keyed.name, repo: keyed.repo};
      }
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
          fromRoot: false,
          entries: unpublishedPackages(json, warn),
        });
    }
  }
  return [...seen.values()];
}

/**
 * The app list's `branch` keys as pins (npm name -> branch): `linked checkout` places a keyed
 * package as a `--pin` places it, and an explicit `--pin` for the same name wins.
 */
export function pinsFromKeys(list: readonly UnpublishedPackage[]): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const entry of list) if (entry.branch !== undefined) pins[entry.name] = entry.branch;
  return pins;
}

/**
 * `text` (a `package.json`) without the `branch` key of any `linked.unpublishedPackages` entry,
 * and the npm names whose key went. Everything else stays as it was: key order, the file's
 * indent and its trailing newline. No key: `text` unchanged and `stripped` empty.
 */
export function stripBranchKeys(text: string): {text: string; stripped: string[]} {
  const json: unknown = JSON.parse(text);
  const linked: unknown = json && typeof json === 'object' ? (json as {linked?: unknown}).linked : undefined;
  const list: unknown =
    linked && typeof linked === 'object' ? (linked as {unpublishedPackages?: unknown}).unpublishedPackages : undefined;
  const stripped: string[] = [];
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    for (const [name, entry] of Object.entries(list as Record<string, unknown>)) {
      if (entry && typeof entry === 'object' && 'branch' in entry) {
        delete (entry as {branch?: unknown}).branch;
        stripped.push(name);
      }
    }
  }
  if (!stripped.length) return {text, stripped};
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
  const eol = /\r?\n$/.exec(text)?.[0] ?? '';
  const body = JSON.stringify(json, null, indent);
  return {text: (eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body) + eol, stripped};
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
