// The browser side of the dual-copy e2e (cli report 021): which `@_linked/*`
// script modules the page requested in more than one form.
//
// Vite gives a module one id per URL, so the same file requested as
// `/node_modules/@_linked/x/src/a.tsx` and as `…/a.tsx?v=1234` (report 018),
// or from two paths (a node_modules copy and an `/@fs/` one), is evaluated
// twice: two React contexts, two registries, failing `instanceof`. A package
// served both from Vite's optimizer (`/node_modules/.vite/deps/_linked_x.js`)
// and file by file is two copies as well (cli#272).

export type ModuleCopies = {
  /** `@_linked/<name>/<path in the package>`, or `@_linked/<name>` for an optimizer copy. */
  module: string;
  /** Every URL it was requested as, sorted. */
  urls: string[];
};

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
// The innermost package: `…/node_modules/@_linked/<name>/<rest>`, or a
// localized checkout `…/_linked-<name>/<rest>` reached through `/@fs/`.
const PACKAGE_FILE = /.*(?:\/@_linked\/|\/_linked-)([^/]+)\/(.+)$/;
const OPTIMIZED = /\/\.vite\/deps\/_linked_([^/]+)\.js$/;

/** The URL without the HMR timestamp (`t`), which a single page load does not vary. */
function requested(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete('t');
  const query = params.toString();
  return url.pathname + (query ? `?${query}` : '');
}

/**
 * Every `@_linked/*` script module requested in more than one form, from a
 * page's request URLs. Same URL twice is one copy (the browser caches it).
 */
export function linkedModuleCopies(urls: string[]): ModuleCopies[] {
  const forms = new Map<string, Set<string>>();
  const optimized = new Map<string, Set<string>>();
  const filePackages = new Set<string>();
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const pathname = decodeURIComponent(url.pathname);
    const dep = OPTIMIZED.exec(pathname);
    if (dep) {
      // `_linked_shape-ui_components_InstanceView` → package `shape-ui`
      // (package names use `-`, the optimizer joins subpaths with `_`).
      const name = dep[1].split('_')[0];
      if (!optimized.has(name)) optimized.set(name, new Set());
      optimized.get(name)!.add(requested(url));
      continue;
    }
    const file = PACKAGE_FILE.exec(pathname);
    if (!file || !SCRIPT.test(file[2]) || pathname.includes('/.vite/'))
      continue;
    const module = `@_linked/${file[1]}/${file[2]}`;
    filePackages.add(file[1]);
    if (!forms.has(module)) forms.set(module, new Set());
    forms.get(module)!.add(requested(url));
  }
  const copies: ModuleCopies[] = [];
  for (const [module, seen] of forms) {
    if (seen.size > 1) copies.push({module, urls: [...seen].sort()});
  }
  for (const [name, seen] of optimized) {
    if (filePackages.has(name)) {
      const files = [...forms]
        .filter(([module]) => module.startsWith(`@_linked/${name}/`))
        .flatMap(([, s]) => [...s]);
      copies.push({
        module: `@_linked/${name}`,
        urls: [...seen, ...files].sort(),
      });
    }
  }
  return copies.sort((a, b) => a.module.localeCompare(b.module));
}
