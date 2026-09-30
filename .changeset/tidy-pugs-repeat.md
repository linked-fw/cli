---
'@_linked/cli': minor
---

Scaffold new packages with the fleet-standard, emit-neutral tsconfig shape.

`defaults/package/tsconfig.json` now pins `rootDir: "./src"` and drops the no-op
`downlevelIteration`, and `tsconfig-esm.json` uses `moduleResolution: "bundler"`
instead of `"node"`. All three options are removed or no longer inferred in
TypeScript 7 (TS5011, TS5102, TS5108), so a package scaffolded today was born
needing the same fix that has just been applied across every `@_linked/*` repo.

The change is emit-neutral: without `rootDir` TypeScript infers it, and the
inferred value is already `./src`; `downlevelIteration` is a no-op at every
target used here (>= es2015).

`RUN_TEMPLATE_FULL=1` now asserts the shape — `rootDir` pinned in the base only,
no `downlevelIteration` or `moduleResolution: node` in any of the three configs,
both derived configs extending the base, and no extra `src/` level in the emit —
so the template cannot drift back.
