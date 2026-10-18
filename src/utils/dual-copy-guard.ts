// Dev-time guard: warn when Node loads a file of a package that the Vite SSR
// runner bundles. Under `linked start` a package in `ssr.noExternal` is
// evaluated by the module runner; if Node also evaluates one of its files (a
// native `import()` from an externalized package, such as core's `loadStores`
// before cli backlog 014), the app holds two copies of that module: classes
// fail `instanceof` and module state (`Server`'s local server, static headers)
// is set on one copy and read on the other.
//
// Uses Node's in-thread `module.registerHooks` (Node 22.15+ / 23.5+). On an
// older Node the guard is a no-op.
import module from 'node:module';
import {fileURLToPath} from 'node:url';

type Matcher = string | RegExp;

const warned = new Set<string>();

/** The npm package name of a bare specifier (`@scope/name/sub` -> `@scope/name`). */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The `@_linked/<name>` package a node_modules file URL belongs to, if any. */
export function linkedPackageOf(
  url: string,
): {name: string; subpath: string} | null {
  if (!url.startsWith('file:')) return null;
  const file = fileURLToPath(url).split('\\').join('/');
  const m = /\/node_modules\/(@_linked\/[^/]+)\/(.*)$/.exec(file);
  return m ? {name: m[1], subpath: m[2]} : null;
}

// Vite tests `ssr.noExternal` against the package name only, so do the same.
export function isBundled(name: string, bundled: Matcher[]): boolean {
  return bundled.some((b) =>
    typeof b === 'string' ? b === name : b.test(name),
  );
}

/**
 * Install the guard. `bundled` is the dev `ssr.noExternal` list. Returns the
 * set of `<package>/<file>` Node loaded, for tests.
 */
export function installDualCopyGuard(
  bundled: Matcher[],
  report: (msg: string) => void = (m) => console.warn(m),
): Set<string> | null {
  const registerHooks = (module as unknown as {registerHooks?: Function})
    .registerHooks;
  if (typeof registerHooks !== 'function') return null;
  const seen = new Set<string>();
  registerHooks({
    resolve(specifier: string, context: {parentURL?: string}, next: Function) {
      const result = next(specifier, context);
      const pkg = result?.url ? linkedPackageOf(result.url) : null;
      // The CLI runs in Node by design; only app-side packages count.
      if (pkg && pkg.name !== '@_linked/cli' && isBundled(pkg.name, bundled)) {
        const key = `${pkg.name}/${pkg.subpath}`;
        seen.add(key);
        if (!warned.has(key)) {
          warned.add(key);
          report(
            `[linked] TWO COPIES: Node loaded ${key} (imported as "${specifier}" from ${context.parentURL ?? '?'}), ` +
              `but ${pkg.name} is bundled for the Vite SSR runner. Classes from it will fail ` +
              '`instanceof` and its module state exists twice. See cli backlog 014.',
          );
        }
      }
      return result;
    },
  });
  return seen;
}
