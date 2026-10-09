/**
 * The app scripts that put `linked localize`'s links back after npm removed
 * them. Shared by `create-package` (which sets them up before it adopts a new
 * package) and by `localize` / `adopt` (which add them when they record a
 * package into an app that does not have them yet).
 *
 * Why TWO hooks, both running the same command: npm runs an app's root
 * `postinstall` only on a bare `npm install` / `npm ci`. It runs a root
 * `dependencies` script after ANY command that changes `node_modules` --
 * `npm install <name>`, `npm update`, `npm uninstall`, `npm dedupe` (npm's
 * arborist, `reify.js`). Each of those replaces a localized link with the
 * registry copy, silently, so `postinstall` alone leaves most of them
 * unguarded. A bare `npm install` runs both scripts; `--relink` is idempotent
 * and silent when there is nothing to do, so running twice costs nothing.
 *
 * With no `local-packages.json` the command prints nothing and exits 0, so the
 * hooks are safe to commit for everyone.
 */
import fs from 'fs';

export const RELINK_COMMAND = 'linked localize --relink';

/** The npm lifecycle scripts that run {@link RELINK_COMMAND}. See the module header. */
export const RELINK_HOOKS = ['postinstall', 'dependencies'] as const;

/** Also matches the retired `linked-localize --relink` spelling. */
const RELINKS = /localize\s+--relink/;

/**
 * Make sure each of the app's {@link RELINK_HOOKS} runs {@link RELINK_COMMAND}:
 * set it when absent, append it with `&&` to a script that does something
 * else, and leave a script that already relinks alone. Mutates `pkg`.
 *
 * @returns the hooks it added the command to (empty when nothing changed).
 */
export function ensureRelinkHooks(pkg: Record<string, any>): string[] {
  pkg.scripts = pkg.scripts ?? {};
  const added: string[] = [];
  for (const hook of RELINK_HOOKS) {
    const current: string | undefined = pkg.scripts[hook];
    if (current && RELINKS.test(current)) continue;
    pkg.scripts[hook] = current
      ? `${current} && ${RELINK_COMMAND}`
      : RELINK_COMMAND;
    added.push(hook);
  }
  return added;
}

/**
 * {@link ensureRelinkHooks} on a `package.json` file, keeping its indentation
 * and trailing newline. A missing or unparseable file is left alone.
 *
 * @returns the hooks it added (empty when nothing changed or nothing could be).
 */
export function ensureRelinkHooksInFile(pkgPath: string): string[] {
  let text: string;
  let pkg: Record<string, any>;
  try {
    text = fs.readFileSync(pkgPath, 'utf8');
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return [];
  const added = ensureRelinkHooks(pkg);
  if (!added.length) return added;
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2;
  const eol = text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + eol);
  return added;
}
