/**
 * `linked doctor resolve` — where Vite and where Node resolve each `@_linked`
 * package, run from the app root.
 *
 * Vite's dev SSR runner loads a bundled package from the directory
 * `discoverWorkspaces` maps its name to (a source workspace), while Node loads
 * whatever its `node_modules` walk finds. In a worktree whose `packages-local/`
 * holds its own checkout of a package, the two differ on purpose (an overlay).
 * It is a defect only for a package that Node also loads during `linked start`:
 * then the process holds two copies with separate module state.
 *
 * "Bundled" is computed with the same functions `createViteConfig` uses in dev
 * (`discoverWorkspaces`, `workspaceDependents`, `ssrBundledWorkspaces`,
 * `ssrNoExternal`, `ssrExternal`), so this report follows the real config.
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';

import {
  discoverWorkspaces,
  ssrBundledWorkspaces,
  ssrExternal,
  ssrNoExternal,
  workspaceDependents,
  type WorkspaceEntry,
} from '../vite-config.js';

/**
 * Packages Node itself loads while `linked start` runs, so a bundled copy of
 * one of them is a second instance in the same process:
 * - `@_linked/cli`: the `linked` bin is the CLI, loaded from its `lib/`.
 * - `@_linked/auth`: CN's `vite.config.ts` imports
 *   `@_linked/auth/utils/cookieNames` natively when Vite reads its config.
 */
export const NODE_LOADED = ['@_linked/cli', '@_linked/auth'];

export type ResolveFlag = 'two-copies' | 'overlay' | '';

export interface ResolveRow {
  name: string;
  /** Realpathed root Vite's SSR runner loads the package from, or `external`. */
  vite: string;
  /** Realpathed root Node resolves the package to from the app, or `null` when not installed. */
  node: string | null;
  bundled: boolean;
  flag: ResolveFlag;
}

export interface ResolveInputs {
  /** Defaults to `discoverWorkspaces([], cwd)`. */
  workspaces?: WorkspaceEntry[];
  /** `ssr.noExternal`; defaults to what `createViteConfig` computes in dev. */
  noExternal?: (string | RegExp)[];
  /** `ssr.external`; defaults to `ssrExternal(true)`. */
  external?: string[];
}

const realpath = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Vite matches `ssr.noExternal` entries against the bare package name, and a
 * name in `ssr.external` wins over `ssr.noExternal` (Vite 6
 * `createIsConfiguredAsExternal`). That matters for the CLI: `workspaceDependents`
 * can list it (it depends on workspace packages), but `ssrExternal(true)` names it.
 */
function isBundled(noExternal: (string | RegExp)[], external: string[], name: string): boolean {
  if (external.includes(name)) return false;
  return noExternal.some((p) => (typeof p === 'string' ? p === name : p.test(name)));
}

/**
 * The package root Node resolves `name` to from `cwd`. Many `@_linked`
 * packages don't export `./package.json`, so a failed `require.resolve` falls
 * back to Node's own lookup: `<dir>/node_modules/<name>` from `cwd` upward.
 */
export function nodeResolveRoot(name: string, cwd: string): string | null {
  try {
    const req = createRequire(path.join(cwd, 'noop.js'));
    return realpath(path.dirname(req.resolve(`${name}/package.json`)));
  } catch {
    /* not exported, or not installed: walk */
  }
  let dir = path.resolve(cwd);
  while (true) {
    const root = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(root, 'package.json'))) return realpath(root);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Names under `<cwd>/node_modules/@_linked/`. */
function installedLinkedNames(cwd: string): string[] {
  const scope = path.join(cwd, 'node_modules', '@_linked');
  try {
    return fs
      .readdirSync(scope, {withFileTypes: true})
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => `@_linked/${e.name}`);
  } catch {
    return [];
  }
}

/** One row per discovered workspace and installed `@_linked` package, sorted by name. */
export async function resolveRows(
  cwd: string = process.cwd(),
  inputs: ResolveInputs = {},
): Promise<ResolveRow[]> {
  const workspaces = inputs.workspaces ?? (await discoverWorkspaces([], cwd));
  const noExternal =
    inputs.noExternal ??
    ssrNoExternal(workspaces, await workspaceDependents(ssrBundledWorkspaces(workspaces), cwd));
  const external = inputs.external ?? ssrExternal(true);
  const wsRoot = new Map(workspaces.map((w) => [w.name, realpath(path.dirname(w.srcDir))]));
  const names = [...new Set([...workspaces.map((w) => w.name), ...installedLinkedNames(cwd)])].sort();

  return names.map((name) => {
    const node = nodeResolveRoot(name, cwd);
    const bundled = isBundled(noExternal, external, name);
    // A bundled package that is not a workspace is resolved by Vite through
    // node_modules, the same lookup as Node.
    const vite = bundled ? (wsRoot.get(name) ?? node ?? 'external') : 'external';
    let flag: ResolveFlag = '';
    if (bundled && vite !== node) {
      flag = NODE_LOADED.includes(name) ? 'two-copies' : 'overlay';
    }
    return {name, vite, node, bundled, flag};
  });
}

/** A path relative to the parent of `cwd` when that is shorter. */
function show(p: string | null, cwd: string): string {
  if (p === null) return '(not installed)';
  if (p === 'external') return p;
  const rel = path.relative(path.dirname(cwd), p);
  return rel.length < p.length ? rel : p;
}

export function formatTable(rows: ResolveRow[], cwd: string): string {
  const header = ['name', 'vite', 'node', 'bundled', 'flag'];
  const cells = rows.map((r) => [
    r.name,
    show(r.vite, cwd),
    show(r.node, cwd),
    r.bundled ? 'yes' : 'no',
    r.flag,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), ...cells.map(line)].join('\n');
}

export interface DoctorResolveOptions {
  json?: boolean;
}

/** Prints the report and returns the exit code: 1 when any row is `two-copies`. */
export async function doctorResolve(
  options: DoctorResolveOptions = {},
  cwd: string = process.cwd(),
  inputs: ResolveInputs = {},
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const rows = await resolveRows(cwd, inputs);
  if (options.json) {
    write(JSON.stringify(rows, null, 2) + '\n');
  } else {
    write(formatTable(rows, cwd) + '\n');
    const twice = rows.filter((r) => r.flag === 'two-copies');
    if (twice.length) {
      write(
        `\n${twice.map((r) => r.name).join(', ')}: Vite bundles a different copy than the one Node loads, ` +
          'so the process runs two instances.\n',
      );
    }
  }
  return rows.some((r) => r.flag === 'two-copies') ? 1 : 0;
}

/** The commander action. */
export async function runDoctorResolve(options: DoctorResolveOptions): Promise<void> {
  process.exitCode = await doctorResolve(options);
}
