/**
 * The set-up's lockfile made without npm, when that is exact.
 *
 * The set-up changes `package.json` in two places: `workspaces` gains
 * `packages-local/*`, and `postinstall`/`dependencies` run the lock-at-rest
 * hook. In the lockfile, those show up only in the root entry
 * (`packages[""]`): its `workspaces` is a verbatim copy of `package.json`'s,
 * and `hasInstallScript` is true once any install script exists. With
 * `packages-local/` empty, nothing else in the tree changes.
 *
 * `npm install --package-lock-only` is not a substitute. It resolves afresh,
 * and on a real app it does more than that one hunk: on create-now (npm 11
 * and 12) it adds the bundled dependencies of an optional package for another
 * platform, which a full install never records, and npm 12 refuses it outright
 * (`EALLOWREMOTE`, fetching that package's tarball to read them). So when the
 * root entry already has both fields in place -- any app with workspaces and
 * an install script -- the edit is made here, and `null` sends the caller to
 * npm for the rest.
 */

/** The dependency fields npm copies into the root entry; they must already agree. */
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * @param lockText  the current `package-lock.json`
 * @param pkg       the app's `package.json` after the set-up
 * @returns the lockfile with the root entry's `workspaces` set to `pkg`'s, or
 *   null when the edit could not be exact: no v2/v3 root entry, no
 *   `workspaces` or `hasInstallScript` in it yet (npm decides where a new key
 *   goes), dependency fields that do not match (`package.json` has unlocked
 *   changes npm must resolve), or a layout `JSON.stringify` would not
 *   reproduce.
 */
export function setupLockfileByEdit(lockText: string, pkg: any): string | null {
  let lock: any;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return null;
  }
  const root = lock?.packages?.[''];
  if (!root || typeof root !== 'object' || !(lock.lockfileVersion >= 2)) return null;
  if (!('workspaces' in root) || root.hasInstallScript !== true) return null;
  if (!pkg || pkg.workspaces === undefined) return null;
  for (const field of DEP_FIELDS) {
    if (!sameDeps(pkg[field], root[field])) return null;
  }

  const eol = lockText.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^\{\r?\n([ \t]+)"/.exec(lockText)?.[1] ?? '  ';
  const format = (value: unknown) =>
    JSON.stringify(value, null, indent).replace(/\n/g, eol) +
    (/\r?\n$/.test(lockText) ? eol : '');
  // Only a file this formatting reproduces byte for byte is rewritten.
  if (format(lock) !== lockText) return null;

  root.workspaces = pkg.workspaces;
  return format(lock);
}

/** npm leaves an empty dependency object out of the root entry. */
function sameDeps(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v && typeof v === 'object' && Object.keys(v).length ? JSON.stringify(v) : '';
  return norm(a) === norm(b);
}
