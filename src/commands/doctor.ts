/**
 * `linked doctor resolve` — where each `@_linked/*` package (and every other
 * linked package or source workspace) is loaded from in dev.
 *
 * Two loaders run in `linked start`: Vite's SSR runner, which bundles the
 * packages in `ssr.noExternal` from the directory the workspace table maps
 * them to (a checkout's `src/`), and Node, which resolves the rest through
 * `node_modules`. A package both bundled and loaded natively from a different
 * directory runs twice. In a worktree set that is expected for a package the
 * worktree overlays (`overlay`): Node never loads it during `start`. It is a
 * defect (`two-copies`) only for the packages Node does load while starting.
 */
import fs from 'node:fs';
import path from 'node:path';

import {discoverInstalledLinkedPackages, readInstalledPkg} from '../installed-packages.js';
import {isBundled, type SsrMatcher} from '../utils/ssrBundled.js';
import {discoverWorkspaces, ssrNoExternal, workspaceDependents} from '../vite-config.js';

/** Packages Node loads during `linked start`: the CLI itself and the app's config-time imports. */
export const NODE_LOADED = ['@_linked/cli', '@_linked/auth'];

export type ResolveFlag = 'two-copies' | 'overlay' | null;

export interface ResolveRow {
  name: string;
  /** The directory Vite loads it from, or `external` when Vite hands it to Node. */
  vite: string;
  /** The package root Node resolves from the app, or `missing`. */
  node: string;
  bundled: boolean;
  flag: ResolveFlag;
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function linkedScopeNames(cwd: string): string[] {
  try {
    return fs
      .readdirSync(path.join(cwd, 'node_modules', '@_linked'))
      .filter((n) => !n.startsWith('.'))
      .map((n) => `@_linked/${n}`);
  } catch {
    return [];
  }
}

export async function doctorResolve(
  cwd: string = process.cwd(),
  opts: {noExternal?: SsrMatcher[]} = {},
): Promise<ResolveRow[]> {
  const workspaces = await discoverWorkspaces([], cwd);
  const noExternal =
    opts.noExternal ?? ssrNoExternal(workspaces, await workspaceDependents(workspaces, cwd));
  const workspaceRoot = new Map(workspaces.map((w) => [w.name, realpath(path.dirname(w.srcDir))]));
  const names = new Set<string>([
    ...workspaces.map((w) => w.name),
    ...(await discoverInstalledLinkedPackages(cwd)).map((p) => p.name),
    ...linkedScopeNames(cwd),
  ]);
  const rows: ResolveRow[] = [];
  for (const name of [...names].sort()) {
    const installed = await readInstalledPkg(name, cwd);
    const node = installed ? realpath(installed.root) : 'missing';
    const bundled = isBundled(name, noExternal);
    const vite = bundled ? (workspaceRoot.get(name) ?? node) : 'external';
    let flag: ResolveFlag = null;
    if (bundled && vite !== node) flag = NODE_LOADED.includes(name) ? 'two-copies' : 'overlay';
    rows.push({name, vite, node, bundled, flag});
  }
  return rows;
}

/** Paths under the app shown relative to it; others as they are. */
function show(cwd: string, p: string): string {
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') ? rel : p;
}

export async function runDoctorResolve(
  options: {json?: boolean},
  at: {cwd?: string; noExternal?: SsrMatcher[]} = {},
): Promise<void> {
  const cwd = at.cwd ?? process.cwd();
  const rows = await doctorResolve(cwd, {noExternal: at.noExternal});
  const twoCopies = rows.filter((r) => r.flag === 'two-copies');
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const table = rows.map((r) => [
      r.name,
      show(cwd, r.vite),
      show(cwd, r.node),
      r.flag === 'two-copies' ? 'TWO COPIES' : (r.flag ?? ''),
    ]);
    const header = ['package', 'vite', 'node', 'flag'];
    const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
    const line = (cells: string[]) =>
      cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    console.log(line(header));
    for (const row of table) console.log(line(row));
    if (twoCopies.length)
      console.log(
        `\n${twoCopies.map((r) => r.name).join(', ')}: loaded by Node during start and bundled by Vite from another directory, so the app runs two copies.`,
      );
  }
  if (twoCopies.length) process.exitCode = 1;
}
