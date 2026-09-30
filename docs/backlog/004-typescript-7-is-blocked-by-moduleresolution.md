---
summary: >
  Ten vocabulary repos have open TypeScript 7 PRs, each down to a single error —
  `TS5108: moduleResolution=node10 has been removed`. The emit is safe (48/50 runtime `.js`
  byte-identical between 5.7.3 and 7.0.2, zero IRI strings in the diff), but the obvious fix is
  unavailable fleet-wide: `moduleResolution: node16` forces `module: node16`, and `icons` and
  `xsd` have no `"type": "module"`, so their `lib/esm/` would silently emit CommonJS. Five
  CSS-importing repos also need their `declare module '*.module.css'` moved into a `.d.ts`, and
  TS 7.0.2 ships no `tsserver`, which every repo depends on through
  `typescript-plugin-css-modules`. A coordinated migration, not a per-repo sweep.
status: Open — blocked on a fleet-wide module-format decision
---

# 004 — TypeScript 7 is blocked by `moduleResolution`, not by the compiler

The CLI owns the package `tsconfig` template, so the decision lands here even though the failures
show up in the vocabulary repos.

## Where it stands

Ten repos have an open TS7 PR, each now reduced to **one** error:

| Repo | PR |
|---|---|
| dcat | #35 |
| dcmi | #32 |
| icons | #23 |
| org | #32 |
| owl | #43 |
| primitives | #55 |
| rdfs | #20 |
| schema | #45 |
| sioc | #35 |
| xsd | #34 |

```
error TS5108: Option 'moduleResolution=node10' has been removed.
  Please remove it from your configuration.
```

## The emit is not the risk

Measured across the pair 5.7.3 → 7.0.2: **48 of 50 runtime `.js` files are byte-identical**, and
the diff on the remaining two contains **zero IRI strings** — nothing in the vocabulary surface
moves. So this is not a "does TS7 break our output" question. It is a module-format question.

## Why `node16` is not available

`moduleResolution: node16` forces `module: node16`. Under `module: node16` the emitted format is
decided by the nearest `package.json` `"type"` field, not by the tsconfig:

- **`icons` and `xsd` have no `"type": "module"`.** Measured on `icons`: with `node16`, the
  `lib/esm/` output is emitted as **CommonJS**, silently — the build succeeds, the directory is
  still called `esm`, and every consumer that imports it as ESM gets an interop wrapper instead.

That makes the one-line fix a fleet-wide change of published module format, which is a breaking
change for consumers, not a config tidy-up.

## Two more things that ride along

1. **The five CSS-importing repos** — `auth`, `primitives`, `rdfs`, `schema`, `shape-ui` — carry
   `declare module '*.module.css'` inside a `.ts` file. Under TS7 that ambient has to move into a
   `.d.ts`. Verified: moving it compiles with **zero errors**. This part is cheap and independent.
2. **TS 7.0.2 ships no `tsserver`.** Every repo depends on it transitively through
   `typescript-plugin-css-modules`, which is in the shared tsconfig `plugins` array. Installing
   TS7 therefore breaks editor tooling for anyone who relies on that plugin, even in repos whose
   build is fine.

## What a migration has to settle, in order

1. Do the published packages become real ESM (`"type": "module"` everywhere), or do they move to
   `moduleResolution: bundler`, which TS7 still accepts and which sidesteps the whole
   `module: node16` coupling? **The template has already made both choices** — as of
   `8088b59` (`chore(template): scaffold packages ESM-only, lib-only`, today)
   `defaults/package/package.json` sets `"type": "module"` and
   `defaults/package/tsconfig-esm.json` sets `"moduleResolution": "bundler"`. So the target state
   is settled for *new* packages; what is open is migrating the ten existing ones onto it.
2. Move the CSS ambients to `.d.ts` (independent, do it regardless — see
   [006](006-css-module-ambients-in-packages-that-import-no-css.md) for the packages that should
   not have the ambient at all).
3. Decide what replaces `tsserver` for `typescript-plugin-css-modules`, or drop the plugin.
4. Only then land the ten PRs, as one batch with one release.

Do **not** land them individually: a repo that flips to `node16` while its dependencies have not
gets a resolution graph nothing else in the fleet shares. Landing them on `bundler` — matching
the template — is the cheap path and should be measured before anything else is considered.
