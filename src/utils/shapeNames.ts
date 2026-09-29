import fs from 'fs';
import path from 'path';

/**
 * Text that makes Vite run an extra `esbuild.transform` over a compiled module.
 *
 * Vite's `vite:define` plugin transforms any module containing a `define` key
 * (`process.env` and `import.meta.env` / `import.meta.hot` are its own keys in
 * a client build), and in dev it rewrites `process.env.NODE_ENV` in client
 * modules the same way. That pass does not set `keepNames`, and esbuild
 * renames the inner binding of the class expression tsc emits for a decorated
 * class: `let Foo = class Foo` becomes `class Foo2`.
 */
const RENAME_TRIGGER = /process\.env|import\.meta\.(?:env|hot)/;

/** `Foo = __decorate([ …decorators… ], Foo)`, as tsc emits it. */
const DECORATED = /\b([A-Za-z_$][\w$]*) = __decorate\(\[([\s\S]*?)\], \1\)/g;

export interface ExposedShape {
  file: string;
  className: string;
}

/**
 * Shapes in one compiled module whose identity would change if a bundler
 * renamed their class.
 *
 * A shape's IRI is built from its class name unless `@linkedShape({name})`
 * gives one. Source files are safe: esbuild lowers their decorators to an
 * anonymous `let Foo = class {`, which takes its name from the binding. Only
 * published `lib/` JavaScript carries the self-named class expression, so a
 * compiled shape is exposed exactly when it has no explicit name and its module
 * contains a trigger. `createViteConfig` pins these names
 * (`plugins/pin-compiled-class-names.ts`), but other bundlers and hand-written
 * Vite configs do not, so the explicit name is still the fix. This is how
 * `@_linked/server`'s `LinkedServer` and `LincdAPI` came to register as
 * `LinkedServer2` / `LincdAPI2`.
 */
export const findRenameableShapes = (
  source: string,
  file = '',
): ExposedShape[] => {
  if (!RENAME_TRIGGER.test(source)) return [];
  const found: ExposedShape[] = [];
  for (const [, className, decorators] of source.matchAll(DECORATED)) {
    if (!/\blinkedShape\b/.test(decorators)) continue;
    if (/\blinkedShape\(\s*\{[\s\S]*?\bname\s*:/.test(decorators)) continue;
    found.push({file, className});
  }
  return found;
};

/**
 * Build step: warn about every exposed shape in a package's compiled ESM.
 *
 * A warning, not a failure: it is only a hazard when a consumer's bundler
 * actually rewrites the module, and naming the shape is a change to the
 * package's source that its owner has to make.
 */
export const checkShapeNames = async (
  packagePath: string,
): Promise<true | string> => {
  const libDir = path.join(packagePath, 'lib', 'esm');
  if (!fs.existsSync(libDir)) return true;
  const exposed: ExposedShape[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        exposed.push(
          ...findRenameableShapes(
            fs.readFileSync(full, 'utf8'),
            path.relative(libDir, full),
          ),
        );
      }
    }
  };
  walk(libDir);
  if (exposed.length === 0) return true;
  const listed = exposed.map((s) => `${s.className} (${s.file})`).join(', ');
  return (
    `${exposed.length} shape(s) take their identity from a class name that a ` +
    `consumer's bundler may rename, because the module also reads process.env or ` +
    `import.meta.env: ${listed}. Give each an explicit name: ` +
    `@linkedShape({name: '<ClassName>'}).`
  );
};
