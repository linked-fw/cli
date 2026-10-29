/**
 * The `node_modules` of an agent worktree: a link farm into the main
 * checkout's install.
 *
 * A worktree runs on the main checkout's install (no `npm install` of its
 * own), but its `packages-local/` checkouts must win over the main checkout's
 * for every resolver: Vite, `tsc` and Node. A symlinked `node_modules` gives
 * only Vite the worktree's copies (through its workspace table); `tsc` and
 * Node follow the link into the main checkout and load its copies.
 *
 * So `<worktree>/node_modules` is a real directory: each entry links to the
 * main checkout's entry of the same name, except
 * - a package with a checkout in the worktree's `packages-local/`, or a built
 *   app workspace member in its `packages/` (an overlay), which links to the
 *   worktree's copy; its `@scope` is a real directory whose other entries link
 *   one by one. A step of a master (`linked worktree add --from`) also gets the
 *   master's overlays under its own, so its farm links straight into the
 *   install (the marker records the master as `parent`);
 * - `.bin`, a real directory whose relative links are copied as they are, so
 *   an overlay's bin (`linked` from a `@_linked/cli` checkout) runs the
 *   worktree's copy and every other bin the main checkout's;
 * - npm's hidden lockfile and the tool caches (`.vite`, `.cache`, …), which
 *   are left out: npm would write the lockfile through a link, and a cache
 *   belongs to one checkout.
 * `FARM_MARKER` names the install the farm links into; the git hooks, localize
 * and the Vite cache dir read it to treat the worktree as sharing that install.
 *
 * A package the main checkout installs after the farm was made is missing
 * from it until `linked worktree relink` rebuilds it.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {FARM_MARKER, sharedInstall} from '../localize/shared-install.js';
import {makeBinsExecutable} from '../utils/bin-modes.js';

/** Entries of the main checkout's `node_modules` the farm leaves out. */
export const FARM_SKIP = new Set(['.package-lock.json', '.vite', '.vite-temp', '.cache', FARM_MARKER]);

/** One entry of a directory in the main checkout's `node_modules`. */
export interface SourceEntry {
  name: string;
  /** A directory, or a link to one. */
  dir: boolean;
  /** The target when the entry is a symlink, as `readlink` gives it. */
  link?: string;
}

/** What `planFarm` reads: the top level, the `@scope` directories and `.bin`. */
export interface SourceListing {
  top: SourceEntry[];
  /** Entries of each `@scope` directory, by scope (`@_linked`). */
  scopes: Record<string, SourceEntry[]>;
  bin: SourceEntry[];
}

export type FarmOp =
  /** A real directory. */
  | {op: 'mkdir'; path: string}
  /** A link to `target` (absolute); `dir` says whether it is a directory link. */
  | {op: 'link'; path: string; target: string; dir: boolean}
  /** A copy of a relative link, target unchanged. */
  | {op: 'relink'; path: string; target: string}
  /** A copy of a plain file (a Windows `.bin` shim, say). */
  | {op: 'copy'; path: string; source: string};

/** `@scope/name` → [`@scope`, `name`]; `name` → [null, `name`]. */
function splitName(name: string): [string | null, string] {
  if (name.startsWith('@')) {
    const i = name.indexOf('/');
    return [name.slice(0, i), name.slice(i + 1)];
  }
  return [null, name];
}

/**
 * The operations that build the farm, paths relative to the farm. `source` is
 * the main checkout's `node_modules`; `overlays` maps package names to the
 * absolute directory each one links to. Pure: tests drive it with a listing.
 */
export function planFarm(source: string, listing: SourceListing, overlays: Record<string, string>): FarmOp[] {
  const ops: FarmOp[] = [];
  const byScope = new Map<string, Map<string, string>>();
  const topOverlays = new Map<string, string>();
  for (const [name, dir] of Object.entries(overlays)) {
    const [scope, base] = splitName(name);
    if (scope === null) topOverlays.set(base, dir);
    else byScope.set(scope, (byScope.get(scope) ?? new Map()).set(base, dir));
  }

  const entry = (rel: string, e: SourceEntry): FarmOp =>
    e.dir || e.link !== undefined
      ? {op: 'link', path: rel, target: path.join(source, rel), dir: e.dir}
      : {op: 'copy', path: rel, source: path.join(source, rel)};

  const seen = new Set<string>();
  for (const e of [...listing.top].sort((a, b) => a.name.localeCompare(b.name))) {
    if (FARM_SKIP.has(e.name)) continue;
    seen.add(e.name);
    if (e.name === '.bin') {
      ops.push({op: 'mkdir', path: '.bin'});
      for (const b of [...listing.bin].sort((x, y) => x.name.localeCompare(y.name))) {
        const rel = path.join('.bin', b.name);
        ops.push(b.link !== undefined && !path.isAbsolute(b.link) ? {op: 'relink', path: rel, target: b.link} : entry(rel, b));
      }
      continue;
    }
    const scoped = byScope.get(e.name);
    if (scoped) {
      ops.push({op: 'mkdir', path: e.name});
      const names = new Set<string>();
      for (const s of [...(listing.scopes[e.name] ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
        names.add(s.name);
        const rel = path.join(e.name, s.name);
        const overlay = scoped.get(s.name);
        ops.push(overlay ? {op: 'link', path: rel, target: overlay, dir: true} : entry(rel, s));
      }
      for (const [name, dir] of [...scoped].sort()) {
        if (!names.has(name)) ops.push({op: 'link', path: path.join(e.name, name), target: dir, dir: true});
      }
      continue;
    }
    const overlay = topOverlays.get(e.name);
    ops.push(overlay ? {op: 'link', path: e.name, target: overlay, dir: true} : entry(e.name, e));
  }
  // Overlays the main checkout has not installed at all.
  for (const [name, dir] of [...topOverlays].sort()) {
    if (!seen.has(name)) ops.push({op: 'link', path: name, target: dir, dir: true});
  }
  for (const [scope, entries] of [...byScope].sort()) {
    if (seen.has(scope)) continue;
    ops.push({op: 'mkdir', path: scope});
    for (const [name, dir] of [...entries].sort()) {
      ops.push({op: 'link', path: path.join(scope, name), target: dir, dir: true});
    }
  }
  return ops;
}

function listDir(dir: string): SourceEntry[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return [];
  }
  return names.map((d) => {
    const full = path.join(dir, d.name);
    if (!d.isSymbolicLink()) return {name: d.name, dir: d.isDirectory()};
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      /* dangling: linked as it is */
    }
    return {name: d.name, dir: isDir, link: fs.readlinkSync(full)};
  });
}

/** The listing `planFarm` needs from `source`; only the scopes `overlays` touch are read. */
export function readListing(source: string, overlays: Record<string, string>): SourceListing {
  const scopes: Record<string, SourceEntry[]> = {};
  for (const name of Object.keys(overlays)) {
    const [scope] = splitName(name);
    if (scope && !(scope in scopes)) scopes[scope] = listDir(path.join(source, scope));
  }
  return {top: listDir(source), scopes, bin: listDir(path.join(source, '.bin'))};
}

/** `name` from `<dir>/package.json`, with the manifest; null when it has none. */
function readManifest(dir: string): {name: string; pkg: Record<string, unknown>} | null {
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const name = (pkg as {name?: unknown})?.name;
    return typeof name === 'string' && name ? {name, pkg: pkg as Record<string, unknown>} : null;
  } catch {
    return null;
  }
}

/**
 * The files `exports['.']` resolves to at run time: every string leaf of it
 * except the `types` and `development` conditions (those name sources and
 * declarations, which exist unbuilt). Empty when it has no `.` entry.
 */
function dotExports(exportsField: unknown): string[] {
  let e: unknown = exportsField;
  if (typeof e === 'string' || Array.isArray(e)) return leaves(e);
  if (!e || typeof e !== 'object') return [];
  const keys = Object.keys(e);
  if (keys.some((k) => k.startsWith('.'))) {
    if (!('.' in e)) return [];
    e = (e as Record<string, unknown>)['.'];
  }
  return leaves(e);
}

function leaves(e: unknown, depth = 0): string[] {
  if (typeof e === 'string') return [e];
  if (depth > 5 || !e || typeof e !== 'object') return [];
  if (Array.isArray(e)) return e.flatMap((x) => leaves(x, depth + 1));
  return Object.entries(e as Record<string, unknown>)
    .filter(([k]) => k !== 'types' && k !== 'development')
    .flatMap(([, v]) => leaves(v, depth + 1));
}

/**
 * Whether a workspace member can be loaded as it is: its `main` and every
 * file its `.` export resolves to exist, or it declares none. A member whose
 * entry is a build output (`lib/`) that has not been built (in full) is not.
 */
export function memberUsable(dir: string, pkg: Record<string, unknown>): boolean {
  const entries = [...(typeof pkg.main === 'string' ? [pkg.main] : []), ...dotExports(pkg.exports)];
  return entries.every((e) => fs.existsSync(path.join(dir, e)));
}

/**
 * The packages a worktree gives its own copy of, by package name: each
 * directory in `<worktreeDir>/packages-local/*` with a `package.json` that
 * names it, and each app workspace member in `<worktreeDir>/packages/*` that
 * is usable (see `memberUsable`; an unbuilt one stays the install's until a
 * build and `linked worktree relink`). A `packages-local/` checkout wins over a
 * `packages/` member of the same name.
 */
export function overlaysOf(worktreeDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ['packages', 'packages-local']) {
    const parent = path.join(worktreeDir, sub);
    let dirs: string[];
    try {
      dirs = fs.readdirSync(parent).sort();
    } catch {
      continue;
    }
    for (const d of dirs) {
      const dir = path.join(parent, d);
      const m = readManifest(dir);
      if (!m) continue;
      if (sub === 'packages' && !memberUsable(dir, m.pkg)) continue;
      out[m.name] = dir;
    }
  }
  return out;
}

/** `packages/*` members of `worktreeDir` left out of its overlays because they are not built. */
export function unbuiltMembers(worktreeDir: string): string[] {
  const parent = path.join(worktreeDir, 'packages');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(parent).sort();
  } catch {
    return [];
  }
  return dirs.flatMap((d) => {
    const m = readManifest(path.join(parent, d));
    return m && !memberUsable(path.join(parent, d), m.pkg) ? [m.name] : [];
  });
}

/**
 * The overlays of a worktree whose farm has `parent` (a step of a master):
 * the parent's overlays, then the worktree's own, which win.
 */
export function farmOverlays(worktreeDir: string, parent?: string | null): Record<string, string> {
  return parent ? {...overlaysOf(parent), ...overlaysOf(worktreeDir)} : overlaysOf(worktreeDir);
}

export interface FarmMarker {
  /** The directory that holds the `node_modules` the farm links into. */
  installRoot: string;
  /** Package name → the directory it links to instead. */
  overlays: Record<string, string>;
  /** The master's worktree whose overlays this farm includes under its own (a step of a master). */
  parent?: string;
}

/** The marker of `<worktreeDir>/node_modules`, or null when it is not a farm. */
export function readFarmMarker(worktreeDir: string): FarmMarker | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(worktreeDir, 'node_modules', FARM_MARKER), 'utf8'));
    const m = value as Partial<FarmMarker> | null;
    return m && typeof m.installRoot === 'string'
      ? {installRoot: m.installRoot, overlays: m.overlays ?? {}, ...(typeof m.parent === 'string' ? {parent: m.parent} : {})}
      : null;
  } catch {
    return null;
  }
}

/** A directory link; a junction on Windows, which needs no extra privilege. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function apply(farm: string, ops: FarmOp[]): void {
  for (const op of ops) {
    const p = path.join(farm, op.path);
    switch (op.op) {
      case 'mkdir':
        fs.mkdirSync(p);
        break;
      case 'link':
        if (op.dir) linkDir(op.target, p);
        else fs.symlinkSync(op.target, p, 'file');
        break;
      case 'relink':
        fs.symlinkSync(op.target, p);
        break;
      case 'copy':
        fs.copyFileSync(op.source, p);
        break;
    }
  }
}

export interface LinkResult {
  /** Entries linked in the farm (top level and inside the real scope directories). */
  links: number;
  overlays: Record<string, string>;
  /** What was there before: nothing, the old symlink, or an earlier farm. */
  replaced: 'nothing' | 'symlink' | 'farm';
}

/**
 * Make (or rebuild) `<worktreeDir>/node_modules` as a link farm into
 * `<installRoot>/node_modules`, with `overlays` linking to the worktree's
 * checkouts. A symlinked `node_modules` (the earlier layout) or an earlier
 * farm is replaced; a real install of the worktree's own is refused, never
 * touched. The farm is built next to it and swapped in by rename, so a
 * running process sees one or the other.
 */
export function linkNodeModules(
  installRoot: string,
  worktreeDir: string,
  overlays: Record<string, string>,
  parent?: string,
): LinkResult {
  const source = path.join(installRoot, 'node_modules');
  if (!fs.existsSync(source)) throw new Error(`${source} does not exist: install the main checkout first.`);
  const target = path.join(worktreeDir, 'node_modules');
  let replaced: LinkResult['replaced'] = 'nothing';
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target);
  } catch {
    /* nothing there */
  }
  if (stat) {
    const shared = sharedInstall(worktreeDir);
    if (!shared) throw new Error(`${target} is an install of the worktree's own: left as it is.`);
    replaced = shared.layout;
  }

  // `.bin` links to an overlay's bin run it directly, so it needs the bit npm would have set.
  for (const dir of Object.values(overlays)) makeBinsExecutable(dir);
  const ops = planFarm(source, readListing(source, overlays), overlays);
  const building = `${target}.linking-${process.pid}`;
  fs.rmSync(building, {recursive: true, force: true});
  fs.mkdirSync(building);
  try {
    apply(building, ops);
    const marker: FarmMarker = {installRoot, overlays, ...(parent ? {parent} : {})};
    fs.writeFileSync(path.join(building, FARM_MARKER), JSON.stringify(marker, null, 2) + '\n');
  } catch (error) {
    fs.rmSync(building, {recursive: true, force: true});
    throw error;
  }

  if (replaced === 'symlink') {
    fs.unlinkSync(target);
    fs.renameSync(building, target);
  } else if (replaced === 'farm') {
    // rm never follows the links inside, so the main checkout's install is safe.
    const old = `${target}.old-${process.pid}`;
    fs.renameSync(target, old);
    fs.renameSync(building, target);
    fs.rmSync(old, {recursive: true, force: true});
  } else {
    fs.renameSync(building, target);
  }
  return {links: ops.filter((o) => o.op !== 'mkdir').length, overlays, replaced};
}

/**
 * Remove a farm `linkNodeModules` made (its marker says so); returns whether
 * one was removed. Never removes a real install, and never follows a link.
 */
export function removeFarm(worktreeDir: string): boolean {
  const shared = sharedInstall(worktreeDir);
  if (shared?.layout !== 'farm') return false;
  fs.rmSync(path.join(worktreeDir, 'node_modules'), {recursive: true, force: true});
  return true;
}

/**
 * What a farm lacks against the install it links into: top-level entries the
 * main checkout has installed since, and overlays whose checkout is in
 * `packages-local/` but not linked. Empty when the farm is current or there is
 * no farm.
 */
export function farmStaleness(worktreeDir: string): string[] {
  const shared = sharedInstall(worktreeDir);
  if (shared?.layout !== 'farm') return [];
  const farm = path.join(worktreeDir, 'node_modules');
  const missing: string[] = [];
  const have = new Set(fs.readdirSync(farm));
  for (const name of fs.readdirSync(path.join(shared.installRoot, 'node_modules'))) {
    if (!FARM_SKIP.has(name) && !have.has(name)) missing.push(name);
  }
  for (const [name, dir] of Object.entries(farmOverlays(worktreeDir, readFarmMarker(worktreeDir)?.parent))) {
    let real: string | null = null;
    try {
      real = fs.realpathSync(path.join(farm, name));
    } catch {
      /* not linked */
    }
    if (real !== fs.realpathSync(dir)) missing.push(name);
  }
  return missing.sort();
}

/**
 * A hint for `doctor resolve` in an app worktree: how its `node_modules`
 * falls short of giving its own checkouts to tsc and Node. Empty when nothing
 * does.
 */
export function worktreeLinkHints(appDir: string): string[] {
  const shared = sharedInstall(appDir);
  if (!shared) return [];
  const overlays = Object.keys(overlaysOf(appDir));
  if (shared.layout === 'symlink') {
    return overlays.length
      ? [
          `node_modules is a symlink to ${path.join(shared.installRoot, 'node_modules')}: tsc and Node load the main checkout's ` +
            `${overlays.join(', ')}, not this worktree's. Run linked worktree relink here to give them this worktree's.`,
        ]
      : [];
  }
  const stale = farmStaleness(appDir);
  return stale.length
    ? [
        `node_modules lacks ${stale.length > 5 ? `${stale.slice(0, 5).join(', ')} and ${stale.length - 5} more` : stale.join(', ')} ` +
          `(installed in the main checkout, or added to packages-local/, since it was linked). Run linked worktree relink here.`,
      ]
    : [];
}
