/**
 * The one-time setup an app needs before a checkout can be a workspace
 * member, made by `linked localize` and committed by the developer:
 *
 * - `"packages-local/*"` in `workspaces`, so npm links and dedupes checkouts;
 * - `postinstall` and `dependencies` run the lock-at-rest hook, which puts the
 *   committed `package-lock.json` back after npm rewrote it to list them;
 * - `.gitignore` keeps checkouts and parked checkouts out of git.
 *
 * Idempotent: a second run changes nothing and returns `[]`. `package.json` is
 * rewritten only when something changed, with its own indentation, key order
 * and trailing newline, so the diff is the setup and nothing else.
 *
 * It never edits `overrides`. npm refuses (`EOVERRIDE`) a root override on a
 * workspace member's name, and what to do about it -- drop the override or
 * not localize -- is the developer's call; `conflictingOverrides` names them.
 */
import fs from 'node:fs';
import path from 'node:path';

import {LocalizeError, EXIT_REFUSED} from './errors.js';
import {LOCAL_DIR, PARKED_DIR} from './members.js';

export interface SetupChange {
  file: 'package.json' | '.gitignore';
  what: string;
}

export const WORKSPACE_GLOB = `${LOCAL_DIR}/*`;
/** What the app's `postinstall` and `dependencies` run. A path, not `linked`: see hooks/lock-at-rest.cjs. */
export const LOCK_AT_REST_COMMAND =
  'node node_modules/@_linked/cli/hooks/lock-at-rest.cjs';
const HOOK_SCRIPTS = ['postinstall', 'dependencies'] as const;
/** What an app ran before checkouts were workspace members; the hook replaces it. */
const OLD_RELINK = /^(npx )?linked localize --relink$/;
const IGNORED = [`${LOCAL_DIR}/`, `${PARKED_DIR}/`];

/** Make the app ready for checkouts; returns what it changed. */
export function ensureAppSetup(appRoot: string): SetupChange[] {
  return [...setupPackageJson(appRoot), ...setupGitignore(appRoot)];
}

function setupPackageJson(appRoot: string): SetupChange[] {
  const file = path.join(appRoot, 'package.json');
  const {text, pkg} = readPackageJson(file);
  const changes: SetupChange[] = [];
  const change = (what: string) => changes.push({file: 'package.json', what});

  // npm reads an array; the `{packages: [...]}` form is yarn's, and npm reads its `packages` too.
  const ws = pkg.workspaces;
  const globs: unknown[] | null = Array.isArray(ws)
    ? ws
    : ws && typeof ws === 'object' && Array.isArray(ws.packages)
      ? ws.packages
      : null;
  if (!globs) {
    if (ws !== undefined)
      throw new LocalizeError(
        `[localize] package.json "workspaces" is neither a list nor {"packages": [...]}; ` +
          `add "${WORKSPACE_GLOB}" to it by hand.`,
        EXIT_REFUSED,
      );
    pkg.workspaces = [WORKSPACE_GLOB];
    change(`workspaces: ["${WORKSPACE_GLOB}"]`);
  } else if (!globs.includes(WORKSPACE_GLOB)) {
    globs.push(WORKSPACE_GLOB);
    change(`workspaces += "${WORKSPACE_GLOB}"`);
  }

  if (pkg.scripts === undefined) pkg.scripts = {};
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))
    throw new LocalizeError(
      '[localize] package.json "scripts" is not an object.',
      EXIT_REFUSED,
    );
  for (const name of HOOK_SCRIPTS) {
    const before: unknown = scripts[name];
    const next = withHook(typeof before === 'string' ? before : undefined);
    if (next === before) continue;
    scripts[name] = next;
    change(
      typeof before === 'string'
        ? `scripts.${name}: "${before}" -> "${next}"`
        : `scripts.${name}: "${next}"`,
    );
  }

  if (changes.length) {
    const indent = text.match(/^([ \t]+)"/m)?.[1] ?? '  ';
    const eol = text.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, JSON.stringify(pkg, null, indent) + eol);
  }
  return changes;
}

/**
 * The script with the hook in it: the hook alone for none, an old
 * `linked localize --relink` step replaced by it, anything else kept with the
 * hook after it. A script that already runs the hook is returned as it is.
 */
function withHook(script: string | undefined): string {
  if (script === undefined || !script.trim()) return LOCK_AT_REST_COMMAND;
  if (script.includes('hooks/lock-at-rest.cjs')) return script;
  const steps = script.split('&&').map((s) => s.trim());
  if (steps.some((s) => OLD_RELINK.test(s)))
    return steps
      .map((s) => (OLD_RELINK.test(s) ? LOCK_AT_REST_COMMAND : s))
      .join(' && ');
  return `${script} && ${LOCK_AT_REST_COMMAND}`;
}

function setupGitignore(appRoot: string): SetupChange[] {
  const file = path.join(appRoot, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* none yet */
  }
  // `packages-local`, `/packages-local` and `packages-local/` all ignore the directory.
  const have = new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')),
  );
  const missing = IGNORED.filter((line) => !have.has(line.replace(/\/$/, '')));
  if (!missing.length) return [];
  const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(
    file,
    `${text}${sep}# linked localize\n${missing.join('\n')}\n`,
  );
  return missing.map((line) => ({file: '.gitignore', what: `ignore ${line}`}));
}

/**
 * The `overrides` keys -- at any depth, as `a > b` -- that name one of
 * `names`. A root one makes npm fail with `EOVERRIDE` once that package is a
 * workspace member; a nested one installs, but overrides the checkout the
 * developer localized it to use.
 */
export function conflictingOverrides(
  appRoot: string,
  names: string[],
): string[] {
  const {pkg} = readPackageJson(path.join(appRoot, 'package.json'));
  const wanted = new Set(names);
  const found: string[] = [];
  const walk = (overrides: unknown, trail: string[]) => {
    if (!overrides || typeof overrides !== 'object') return;
    for (const [key, value] of Object.entries(overrides)) {
      if (key === '.') continue;
      const keyPath = [...trail, key];
      if (wanted.has(overrideName(key))) found.push(keyPath.join(' > '));
      walk(value, keyPath);
    }
  };
  walk(pkg.overrides, []);
  return found;
}

/** `@scope/name@^2` -> `@scope/name`, `name@1` -> `name`. */
function overrideName(key: string): string {
  const at = key.indexOf('@', 1);
  return at === -1 ? key : key.slice(0, at);
}

function readPackageJson(file: string): {
  text: string;
  pkg: Record<string, any>;
} {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new LocalizeError(
      `[localize] no package.json at ${path.dirname(file)}.`,
      EXIT_REFUSED,
    );
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    throw new LocalizeError(
      `[localize] ${file} is not valid JSON: ${(e as Error).message}`,
      EXIT_REFUSED,
    );
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg))
    throw new LocalizeError(
      `[localize] ${file} is not a JSON object.`,
      EXIT_REFUSED,
    );
  return {text, pkg: pkg as Record<string, any>};
}
