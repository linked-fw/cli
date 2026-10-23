// Mapping a source package's built `lib/esm` file back to its `src/` file.
// Shared by the dev resolver (`linked:resolve-workspace-ts`, vite-config.ts)
// and `linked start`'s module loader, so both pick the same source file.
// Kept free of Vite so `commands/start.ts` can import it statically.
import fs from 'node:fs/promises';
import path from 'node:path';

/** The name of the dev resolver plugin that maps source workspaces to `src/` (vite-config.ts). */
export const RESOLVE_WORKSPACE_PLUGIN = 'linked:resolve-workspace-ts';

export const isFile = async (p: string): Promise<boolean> =>
  fs
    .stat(p)
    .then((st) => st.isFile())
    .catch(() => false);

/**
 * Map a `lib/esm` file (`rel`, relative to `lib/esm`) back to its source under
 * `srcDir`: `.js`/`.jsx` probe `.tsx` then `.ts`, anything else (css, json,
 * ...) is taken literally. Null when no such file exists.
 */
export async function libTargetToSource(
  srcDir: string,
  rel: string,
): Promise<string | null> {
  if (/\.jsx?$/.test(rel)) {
    const base = path.join(srcDir, rel.replace(/\.jsx?$/, ''));
    for (const ext of ['.tsx', '.ts']) {
      if (await isFile(base + ext)) return base + ext;
    }
    return null;
  }
  const literal = path.join(srcDir, rel);
  return (await isFile(literal)) ? literal : null;
}
