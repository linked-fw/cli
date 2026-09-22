// Node ESM loader for .ts / .tsx / .mts / .cts. Transforms via esbuild
// with `experimentalDecorators: true` forced on — @_linked/core's
// @literalProperty / @objectProperty / @linkedShape ship the legacy
// signature `(target, propertyKey, descriptor)`, so the loader has to
// produce legacy `__decorate(...)` calls. tsx (which we previously
// relied on) ignores experimentalDecorators since esbuild's default
// follows the TC39 standard decorator proposal — that mismatch silently
// broke decorator-based property registration in user scripts.
import {readFileSync, existsSync, statSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {transformSync} from 'esbuild';

// Read the user's tsconfig once at boot. We re-use it for every TS file
// we transform so a single source of truth (the user app's tsconfig)
// drives target / jsx / paths / etc.
const userTsconfigPath = path.join(process.cwd(), 'tsconfig.json');
let userTsconfigRaw: any = {compilerOptions: {}};
if (existsSync(userTsconfigPath)) {
  try {
    userTsconfigRaw = JSON.parse(readFileSync(userTsconfigPath, 'utf8'));
    userTsconfigRaw.compilerOptions = userTsconfigRaw.compilerOptions ?? {};
  } catch {
    // Fall back to empty config if parsing fails — esbuild still works.
  }
}
// Force legacy decorator emit regardless of what the user's tsconfig says.
userTsconfigRaw.compilerOptions.experimentalDecorators = true;
const tsconfigRaw = JSON.stringify(userTsconfigRaw);

const TS_EXT = /\.(tsx?|mts|cts)$/;
const TS_RESOLUTION_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
/** Just the TypeScript ones, for mapping a `.js` specifier onto its source. */
const TS_EXTS_ONLY = ['.ts', '.tsx', '.mts', '.cts'];

// Node's default ESM resolver requires explicit extensions on relative
// specifiers. App code (and the cli's user-app imports) routinely omits
// them — tsx used to backfill this, so we have to as well. We only
// touch `./foo` / `../foo` style imports; bare specifiers go straight to
// Node's resolver.
export async function resolve(
  specifier: string,
  context: any,
  nextResolve: (specifier: string, context: any) => Promise<any>,
): Promise<any> {
  // Direct .ts/.tsx/.mts/.cts specifier (relative or absolute path).
  // Node's default ESM resolver doesn't accept these extensions, so we
  // short-circuit and let our `load` hook do the transform.
  if (TS_EXT.test(specifier)) {
    if (specifier.startsWith('file://')) {
      return {url: specifier, shortCircuit: true, format: 'module'};
    }
    if (path.isAbsolute(specifier)) {
      return {
        url: pathToFileURL(specifier).href,
        shortCircuit: true,
        format: 'module',
      };
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const parentUrl = context.parentURL;
      if (parentUrl) {
        const parentPath = fileURLToPath(parentUrl);
        const resolved = path.resolve(path.dirname(parentPath), specifier);
        return {
          url: pathToFileURL(resolved).href,
          shortCircuit: true,
          format: 'module',
        };
      }
    }
  }

  // A relative `./x.js` that has no `./x.js` on disk, written by TypeScript
  // source that means `./x.ts`. This is the NodeNext convention — TS requires
  // the `.js` spelling in emitted-ESM code and rewrites nothing — and it is also
  // what a self-referential ontology namespace import looks like
  // (`import * as _this from './vocab.js'`). Without this, such a module can
  // only be loaded from a built `lib/`, never from source.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    /\.(js|mjs|cjs)$/.test(specifier)
  ) {
    const parentUrl = context.parentURL;
    if (parentUrl) {
      const parentPath = fileURLToPath(parentUrl);
      const asWritten = path.resolve(path.dirname(parentPath), specifier);
      if (!existsSync(asWritten)) {
        const withoutExt = asWritten.replace(/\.(js|mjs|cjs)$/, '');
        for (const candidate of TS_EXTS_ONLY.map((e) => withoutExt + e)) {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return {
              url: pathToFileURL(candidate).href,
              shortCircuit: true,
              format: 'module',
            };
          }
        }
      }
    }
  }

  // Extension-less relative specifier — backfill the extension by probing
  // the disk. App code routinely omits `.ts`/`.tsx` on intra-app imports.
  // `path.extname` treats any text after the last dot as an extension, so
  // `./tailwind.config` looks "extended" by `.config`; only treat the
  // specifier as resolved when the suffix matches a known JS/TS ext.
  const ext = path.extname(specifier);
  const knownExt = TS_RESOLUTION_EXTS.includes(ext);
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !knownExt
  ) {
    const parentUrl = context.parentURL;
    if (parentUrl) {
      const parentPath = fileURLToPath(parentUrl);
      const resolvedBase = path.resolve(path.dirname(parentPath), specifier);
      const candidates = [
        ...TS_RESOLUTION_EXTS.map((ext) => resolvedBase + ext),
        ...TS_RESOLUTION_EXTS.map((ext) =>
          path.join(resolvedBase, 'index' + ext),
        ),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return {
            url: pathToFileURL(candidate).href,
            shortCircuit: true,
            format: 'module',
          };
        }
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(
  url: string,
  context: any,
  nextLoad: (url: string, context: any) => Promise<any>,
): Promise<any> {
  if (!TS_EXT.test(url)) {
    return nextLoad(url, context);
  }
  const filePath = fileURLToPath(url);
  const source = readFileSync(filePath, 'utf8');
  const isTsx = url.endsWith('.tsx');
  const {code} = transformSync(source, {
    loader: isTsx ? 'tsx' : 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: filePath,
    sourcemap: 'inline',
    tsconfigRaw,
    // Honour `"jsx": "react-jsx"` from tsconfig — esbuild doesn't
    // always pick it up via tsconfigRaw, leaving SSR with "React is
    // not defined". Forcing `automatic` injects the jsx-runtime import.
    jsx: 'automatic',
    // Keep `import x from './data.json' with { type: 'json' }` syntax in
    // the output — Node 22+ requires the attribute on JSON imports and
    // esbuild strips it by default when downleveling below esnext.
    supported: {'import-attributes': true},
  });
  return {
    format: 'module',
    source: code,
    shortCircuit: true,
  };
}
