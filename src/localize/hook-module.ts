/**
 * Loads a module from this package's `hooks/` -- plain CommonJS the npm and
 * git hooks run without `lib/` -- so the commands apply the same rules as the
 * hooks rather than a second copy of them.
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * `hooks/<file>` in this package: two levels up from `src/localize/`, three
 * from `lib/esm/localize/`, so it is looked for upwards.
 */
function hookFile(file: string): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'hooks', file);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(
        `[localize] hooks/${file} not found above ${fileURLToPath(import.meta.url)}`,
      );
    dir = parent;
  }
}

/**
 * `hooks/<file>`, required. `isValid` checks the exports the caller relies on,
 * so a mismatched file fails here, by name, rather than at the first call.
 */
export function requireHook<T>(file: string, isValid: (mod: T) => boolean): T {
  const found = hookFile(file);
  const mod: T = createRequire(import.meta.url)(found);
  if (!mod || !isValid(mod))
    throw new Error(`[localize] ${found} does not export what localize needs`);
  return mod;
}
