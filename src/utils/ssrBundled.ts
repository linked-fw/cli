// Which packages the Vite SSR runner bundles. Vite tests `ssr.noExternal`
// against the bare package name only (a subpath pattern never matches), so
// these helpers do the same. Used by `linked start`'s store loader (cli
// backlog 014).

export type SsrMatcher = string | RegExp;

/** The npm package name of a bare specifier (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`). */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Whether `name` is in a `ssr.noExternal` list: a string entry is equal, a RegExp entry tests the name. */
export function isBundled(
  name: string,
  noExternal: readonly SsrMatcher[],
): boolean {
  return noExternal.some((entry) =>
    typeof entry === 'string' ? entry === name : entry.test(name),
  );
}
