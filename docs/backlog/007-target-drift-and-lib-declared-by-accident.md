---
summary: >
  The fleet's ESM configs disagree on `target` — `es6` in some repos, `es2018` in others, for the
  same output — with no stated reason, and 18 of 19 repos set a `target` without ever declaring
  `lib`, so the ambient library surface is whatever `@types/node` happens to supply. `core` was
  fixed today (`lib: ["ES2022","DOM","DOM.Iterable"]`) because it had a live dependency on that
  accident: `@types/node` v20 shipped a polyfill declaration for `Array.prototype.at()` and v24
  does not, so `core` only ever typechecked because a dependency declared it. The other repos are
  hygiene, not urgent.
status: Open — low priority, but the template should stop producing it
---

# 007 — `target` drift, and `lib` declared by accident

## The drift

The per-output configs disagree on `target` for the same kind of emit and give no reason:

```
$ cat xsd/tsconfig-esm.json
{"extends":"./tsconfig.json","compilerOptions":{
  "module":"esnext","target":"es2018","outDir":"lib/esm","moduleResolution":"node"}}
```

while `cli`, `core` and `react` set `target: es6` at the root. The template
(`defaults/package/tsconfig-esm.json`) says `es2018` and declares **no `lib`**. Nothing records
which target is intended or why, so every package inherits whichever template it was scaffolded
from.

## The part that actually bit

**18 of 19 repos set a `target` and declare no `lib`.** Only `translation` declared one
(`["ES2022","DOM"]`) before today. Without an explicit `lib`, the ambient surface is the default
for the target *plus whatever any installed `@types` package declares* — which makes it a function
of the dependency tree rather than of the config.

That is not theoretical. `core` was fixed today, in
[linked-fw/core#291](https://github.com/linked-fw/core/pull/291) (`fix(tsconfig): declare lib
explicitly instead of inheriting it by accident`), to `lib: ["ES2022","DOM","DOM.Iterable"]`. The
mechanism:

- `@types/node` **v20** shipped a polyfill declaration for `Array.prototype.at()`.
- `@types/node` **v24** does not.
- `core` used `.at()` and its `target` did not provide it. It typechecked only because a
  *dependency* happened to declare the method. The Renovate bump to `@types/node` v24 removed the
  declaration and the build broke — in `core`, from a change to `@types/node`.

## What to do

1. Pick one `target` per output format and state the reason in the template (a comment in the
   template tsconfig, not a doc nobody opens).
2. Make the template emit an explicit `lib` — `defaults/package/tsconfig-esm.json` has none
   today — so the ambient surface is a decision rather than a side effect of the dependency tree.
3. Backfill the 17 remaining repos. This is hygiene — none of them is known to be broken today —
   so it can ride along with whatever release touches them next, and does not need its own sweep.

Related: the same template also emits a CSS ambient into packages that import no CSS
([006](006-css-module-ambients-in-packages-that-import-no-css.md)), and the same configs are what
TypeScript 7 rejects ([004](004-typescript-7-is-blocked-by-moduleresolution.md)). A single pass
over the template can settle all three.
