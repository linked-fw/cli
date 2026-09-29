// Keeps the runtime name of tsc-compiled decorated classes stable through Vite.
//
// A shape's IRI is built from its class name when `@linkedShape` is given no
// explicit `name`, so anything that renames a shape class changes the shape's
// identity. For a decorated class tsc emits
//
//   let Foo = class Foo { ... };
//   Foo = __decorate([linkedShape], Foo);
//
// and esbuild, whenever it re-prints such a module, renames the inner binding
// to avoid the shadowing: `let Foo = class Foo2`. The class is then called
// `Foo2` at runtime — before any decorator sees it — and registers under the
// wrong IRI. Vite re-prints a module with esbuild, without `keepNames`, in its
// `vite:define` pass (client build: any module mentioning `process.env`,
// `import.meta.env`, `import.meta.hot` or an app `define` key) and in the dev
// client whenever a module mentions `process.env.NODE_ENV`. Neither pass can be
// given `keepNames`, and `esbuild.keepNames` in the Vite config does not reach
// them: it only reaches the minifier, which then keeps the already-wrong name.
//
// TypeScript source is not affected — esbuild lowers its decorators to an
// anonymous `let Foo = class {`, which takes its name from the binding. Only
// published lib JavaScript carries the self-named class expression.
//
// So before any of that runs, this plugin pins each such class's name with a
// string literal placed right after its declaration — before the property and
// class decorators run — which no later renaming can touch:
//
//   let Foo = class Foo { ... }; Object.defineProperty(Foo, "name", {value: "Foo", configurable: true});
//
// The insertion is on the declaration's own last line and moves no code, so
// existing source maps stay valid (`map: null`).
import type {Plugin} from 'vite';

/** An ESTree parser — the plugin context's `this.parse` (Rollup's parser). */
export type ParseAst = (code: string) => any;

/** Cheap pre-filter: a self-named class expression bound to a variable. */
const SELF_NAMED_CLASS =
  /\b(?:let|var|const)\s+([\w$]+)\s*=\s*(?:[\w$]+\s*=\s*)*class\s+\1\b/;
const JS_ID = /\.[cm]?js$/;

/**
 * Returns `code` with the runtime name of every top-level tsc-style decorated
 * class expression pinned, or `null` when there is nothing to pin (or the
 * module does not parse as JavaScript).
 */
export function pinDecoratedClassNames(
  code: string,
  parse: ParseAst,
): string | null {
  if (!code.includes('__decorate(') || !SELF_NAMED_CLASS.test(code))
    return null;
  let ast: any;
  try {
    ast = parse(code);
  } catch {
    return null;
  }
  const pins: {at: number; name: string}[] = [];
  for (let node of ast.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration)
      node = node.declaration;
    if (node.type !== 'VariableDeclaration') continue;
    for (const decl of node.declarations) {
      if (decl.id.type !== 'Identifier') continue;
      // `let Foo = Foo_1 = class Foo` — tsc's form when the class refers to itself.
      let init = decl.init;
      while (init && init.type === 'AssignmentExpression') init = init.right;
      if (init?.type === 'ClassExpression' && init.id?.name === decl.id.name) {
        pins.push({at: node.end, name: decl.id.name});
      }
    }
  }
  if (pins.length === 0) return null;
  let out = code;
  for (const {at, name} of pins.reverse()) {
    const pin = ` Object.defineProperty(${name}, "name", {value: ${JSON.stringify(name)}, configurable: true});`;
    out = out.slice(0, at) + pin + out.slice(at);
  }
  return out;
}

export function pinCompiledClassNames(): Plugin {
  return {
    name: 'linked:pin-compiled-class-names',
    enforce: 'pre',
    transform(code, id) {
      if (!JS_ID.test(id.split('?', 1)[0])) return null;
      const pinned = pinDecoratedClassNames(code, (c) => this.parse(c));
      return pinned === null ? null : {code: pinned, map: null};
    },
  };
}
