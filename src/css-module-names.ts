// CSS-module class names for production builds.
//
// A production app computes the same class name in three places, and they must
// agree or the element the server rendered carries a class no stylesheet defines:
//
//   - the client build (Vite, `css.modules.generateScopedName`), which also
//     writes the stylesheet;
//   - the backend/SSR build of the app's own source (Vite again);
//   - the Node runtime (`loaders/css-loader.mts`), which maps the `.module.css`
//     files that externalised packages in node_modules import, e.g. every
//     `@_linked/primitives` component.
//
// Vite's default name is a hash of the processed CSS text, which the Node loader
// cannot reproduce; the loader used to hash the absolute file URL, which the
// client build never sees and which changes with every install location. So the
// name is derived only from facts all three agree on: the owning package's
// name, the file's path inside that package with the build-output prefix
// removed, and the class.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Where a stylesheet lives, independent of where it is installed: the name of
 * the nearest package.json that has one, and the path below it. The leading
 * `src/`, `lib/`, `lib/esm/` or `lib/cjs/` is dropped, so a package resolved
 * from its source, its ESM output or its CJS output yields the same location.
 */
export const cssModuleLocation = (filepath: string): {packageName: string; relativePath: string} => {
  const clean = filepath
    .replace(/\?.*$/, '')
    .replace(/^file:\/\//, '');
  let resolved = path.resolve(decodeURIComponent(clean));
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // A path that does not exist (tests, virtual modules) is used as given.
  }
  let dir = path.dirname(resolved);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
        if (typeof name === 'string' && name) {
          const relativePath = path
            .relative(dir, resolved)
            .split(path.sep)
            .join('/')
            .replace(/^(?:src|lib\/esm|lib\/cjs|lib)\//, '');
          return {packageName: name, relativePath};
        }
      } catch {
        // An unreadable package.json does not name the package; keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {packageName: 'unknown', relativePath: path.basename(resolved)};
};

/**
 * The production CSS-module class name: `_<class>_<hash>`. The underscore keeps
 * it a valid CSS identifier even when the hash starts with a digit.
 */
export function generateScopedNameProduction(cssClassName: string, filepath: string, _css?: string) {
  const {packageName, relativePath} = cssModuleLocation(filepath);
  const hash = crypto
    .createHash('md5')
    .update(`${packageName}/${relativePath}:${cssClassName}`)
    .digest('hex')
    .substring(0, 6);
  return `_${cssClassName}_${hash}`;
}

/**
 * The local class names a stylesheet defines, as the Node loader reports them
 * to the module that imports it. Comments are removed first so a commented-out
 * rule does not produce a name.
 */
export const cssModuleClassNames = (source: string): string[] => {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set<string>();
  for (const match of withoutComments.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    names.add(match[1]);
  }
  return [...names];
};

/**
 * What `import styles from './x.module.css'` evaluates to on the server: each
 * local class name mapped to its scoped name. `scope` is the naming function
 * of the current mode.
 */
export const cssModuleExports = (
  source: string,
  filepath: string,
  scope: (cssClassName: string, filepath: string) => string = generateScopedNameProduction,
): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const name of cssModuleClassNames(source)) {
    output[name] = scope(name, filepath);
  }
  return output;
};
