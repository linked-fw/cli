---
summary: >
  A Linked app loading two copies of a framework module has come up 18 times since June 2026, plus
  backlog 014. Each fix closed one path. The causes recur in five places: two loaders in dev SSR
  (Vite's module runner and Node), Vite's dependency optimizer, a workspace or localized copy next
  to an installed one, inlining at build time, and HMR re-evaluation. Recommended: a dev-time
  warning in `linked start` when Node loads a file of a package the SSR runner bundles (spike
  measured 8 to 13 such files in a fresh template app today), a CLI e2e that fails on it, bundling
  every installed `@_linked/*` but core and the CLI in a standalone app (spike: 0 left), and two
  package conventions (module state on `globalThis`, errors checked by brand, not `instanceof`).
status: Open -- fix in progress, CN plan 068 phase 4; option A (the guard) shipped (report 015), option C (standalone bundles every @_linked/* but core and the CLI) shipped (report 016: template 0 / 0, webid.email 0 with core 2.34.0+; CN localized layout not measured, owner's CN was running), B to do
---

# 015 — One copy of each framework package

## The bug class

A class or module state from a `@_linked/*` package exists twice in one process or page, so
`instanceof` fails across the two, a registry or static is written on one copy and read on the
other, or a React context has two identities. It shows as symptoms far from the cause: "No query
dispatch configured", `useAppContext()` null, a raw error stack instead of a boot message, a shape
called `Person3`. Backlog 014 is the newest case.

## Past occurrences

Dates are when the report or commit landed. Paths are in `Semantu/create-now` (CN) unless a repo
is named.

| # | When, where | Showed in | Cause | Fix |
|---|---|---|---|---|
| 1 | 2026-06-11, CN report 007 dev. 3 | CN dev SSR: "Multiple versions of LINCD" | Vite bundled workspace core next to Node's core | `ssr.external` for every `@_linked/*` (later reversed, #18) |
| 2 | 2026-06-11, CN report 011; core 3507b09, 5ee8cb1; server 1de3fa1 | CN dev backend: `LinkedStorage` statics twice | `indexLincdPackage` used Node `import()` next to Vite's src core, plus a stale `lib/` | storage config and package index through `ssrLoadModule`; idempotent `initTree`; `LinkedStorage.INSTANCE_ID` guard |
| 3 | 2026-07-09, cli#62 | CN member clones, dev | optimizer pre-bundled workspace packages | workspace packages excluded from `optimizeDeps` |
| 4 | 2026-07-11, CN report 014; cli b9f5428; core 3e07c7d | standalone dev browser: `Person2`/`Person3`, `BackendAPIStore` forwarding dead | optimizer copied core into each per-subpath chunk | `optimizeDeps.exclude` of published `@_linked/*`; suffix-stripped URI fallback; core backlog 032 |
| 5 | 2026-07-12, cli 4a1fe28 | fresh standalone app SSR: "Cannot destructure isNativeApp" | two `ssrLoadModule` loads of external server-utils / React | `noExternal` + dedupe of server-utils and react standalone |
| 6 | 2026-07-22, react 4f4c300 | CN dev: element interceptor never fired | optimizer bundle vs alias-resolved file | registry on `globalThis` |
| 7 | 2026-08-13, CN report 018 | CN dev SSR: `useRef` of null | mid-session re-optimization mixed chunks, duplicate React | pre-include Radix and utils, dedupe react |
| 8 | 2026-08-31, server-utils db0e6b9 | CN dev after HMR: two `AppContext`s | re-evaluation of bundled server-utils | `AppContext` on `globalThis` |
| 9 | 2026-09-22, cli#115 (cli report 003 §2) | CN prod client: TDZ error | registry and workspace copies in different chunks | one chunk for both |
| 10 | 2026-09-24, CN report 043 §1; core#252 | CN built backend boot: pins on the wrong `Project` | backend from `lib/`, storage config from `src/` | pins also match by shape IRI |
| 11 | 2026-09-30, CN reports 067 §B1, 068; cli#161 | CN prod: "exports two generic backend providers", `/api/shapes` 500 | standalone `noExternal` list applied to a release build, inlining a private server-utils | `noExternal: isDev ? … : []`; `assertNoInlinedWorkspaces` |
| 12 | 2026-09-30, CN report 068 §2.2; cli#170 | CN dev SSR: server's `package.js` evaluated twice | `@_linked/server` split across both loaders | `SSR_ENTRY_PACKAGES` |
| 13 | 2026-09-30, CN report 068 | CN prod build: second `@_linked/documents` in `lib/` | dev-only alias applied in every mode | alias dev-only (CN 22e3541c); caught by cli#177 |
| 14 | undated, cli `vite-config.ts` comment at `noExternal` | CN dev SSR: shape registry split | bundling every `@_linked/*` let `loadStores` pull a second Node core | bundle only workspaces and their dependents |
| 15 | 2026-10-02, server 93ebd50 | dev/prod: nested duplicate packages | a nested copy next to the app-resolved one | load backends from the install path; warn on the duplicate |
| 16 | 2026-10-07 to 12, CN reports 073 §11, 077; cli reports 011, 013 | CN with localized checkouts: 3 cores, "Invalid hook call", 82 tsc errors | each checkout installed its own core, React, server-utils | localize on npm workspaces; `localize --list` drift check |
| 17 | 2026-10-12, webid-email backlog 010, report 010 | webid.email standalone dev: `LinkedEmail.setDefaultProvider` lost; localized: two `@_linked/auth`s | (a) bundled server-utils, external `@_linked/auth` imports it through Node; (b) localized copy through CN's tree | (a) open; (b) run from its own worktree (`WIE_DIR`) |
| 18 | 2026-10-16, cli#272 | dev browser with workspaces: `Person` became `Person3` | optimizer pre-bundling | installed linked deps excluded everywhere; optimizer `keepNames` |
| 19 | 2026-10-18, cli backlog 014; app-template#26 | template dev: `instanceof RemoteDataset*` false | `loadStores`' Node `import()` of a bundled package | open (014) |

Related but not two copies: shape identity by name broke under minification (CN reports 042, 053;
cli#127, keepNames), a binding-name collision gave `BackendAPIStore2` (server#84, #87; server
`src/ontologies/server.ts:36-42`), and esbuild's define pass renamed `X` to `X2` (CN report 067
§B2; cli#158, #162). Report 043 §3 suspected a copy and measured one; core moved its registries to
`globalThis` anyway (`ShapeClass.ts:23-53`).

## Causes that recur

1. **Two loaders in dev SSR** (#1, 2, 5, 12, 14, 17a, 19; #10 is the built-app form). `linked start`
   evaluates the app through Vite's module runner, which bundles the packages in `ssr.noExternal`
   and hands everything else to Node. Any external package that imports a bundled one, and any
   native `import()` in Node-loaded code, reaches Node's copy. This is the most frequent cause and
   the one still live: the spike below finds it in a fresh template app.
2. **Vite's dependency optimizer** in the browser (#3, 4, 6, 7, 18): pre-bundled chunks carry their
   own copy, and a re-optimization mid-session mixes old and new chunks.
3. **A workspace, nested or localized copy next to the installed one** (#15, 16, 17b), and a stale
   `lib/` beside `src/` (#2).
4. **Inlining at build time** (#9, 11, 13): a dev-only bundling rule or alias applied to a release
   build.
5. **HMR re-evaluation** (#8): one module, two evaluations over time.

**ESM/CJS dual builds** have not caused a case: every `@_linked/*` package ships ESM only (for
example `@_linked/fuseki`'s `exports` has only `import` conditions). Keep it that way.

What makes each copy hurt is the same in every case: identity checks by class object (`instanceof`,
`Map` keyed by class) and state held in module scope.

## Measured on the spike

Branch [`spike/dual-copies`](https://github.com/linked-fw/cli/tree/spike/dual-copies), same test
app as backlog 014 (fresh `linked create-app`, packages from npm). `src/utils/dual-copy-guard.ts`
registers a Node resolve hook (`module.registerHooks`, Node 22.15+) after the Vite server exists
and prints `[linked] TWO COPIES: Node loaded <file> …` for every file Node loads from a package in
the dev `ssr.noExternal` list (the CLI itself excluded).

| Build | Datasets file | Files flagged | `instanceof` store | `GET /` |
|---|---|---|---|---|
| Today's bundling + 014's loader | RemoteDataset | 8 | `true` | (boot stops at probe) |
| Today's bundling + 014's loader | FusekiStore | 13 | `true` | 200, SSR rendered |
| `LINKED_SSR_BUNDLE_ALL=1` + 014's loader | RemoteDataset | 0 | `true` | (boot stops at probe) |
| `LINKED_SSR_BUNDLE_ALL=1` + 014's loader | FusekiStore | 0 | `true` | 200, SSR rendered |

Before 014's loader, the flags also included `@_linked/server/shapes/quadstores/RemoteDataset` and
`@_linked/server/package.js`, which is 014 itself. What stays with today's bundling, quoted from the
log:

```
Node loaded @_linked/server-utils/lib/esm/utils/Server.js (imported as "@_linked/server-utils/utils/Server" from …/@_linked/schema/lib/esm/shapes/ImageObject.class.js)
Node loaded @_linked/server-utils/lib/esm/utils/ShapeProvider.js (imported as "@_linked/server-utils/utils/ShapeProvider" from …/@_linked/schema/lib/esm/shapes/ImageObjectProvider.js)
Node loaded @_linked/react/lib/esm/utils/LinkedComponent.js (imported as "@_linked/react/utils/LinkedComponent" from …/@_linked/schema/lib/esm/package.js)
Node loaded @_linked/react/lib/esm/utils/ClassNames.js (imported as "@_linked/react/utils/ClassNames" from …/@_linked/primitives/lib/esm/components/Button.js)
```

So in every standalone app today, `@_linked/schema` and `@_linked/primitives` (external) hold a Node
copy of `server-utils` and `react` next to the runner's. `ImageObjectProvider` extends Node's
`ShapeProvider` while `LinkedServer` is the runner's. Whether that drops the provider in dev was not
measured. It is the same mechanism as webid-email backlog 010 (a).

`LINKED_SSR_BUNDLE_ALL=1` makes the standalone `noExternal` list `/^@_linked\/(?!(core|cli)$)/`.
Core stays external (one Node copy, its state is on `globalThis`), so does the CLI (it is the Node
process). Workspace mode is unchanged and was not measured on CN.

## Options

| Option | Effort | Covers |
|---|---|---|
| A. Dev warning in `linked start`: Node resolve hook against the dev `noExternal` list (spike code) | 0.5 day with unit tests | every cause-1 case in dev SSR, standalone and workspace, at the moment it happens, naming the importer; not the browser, not prod |
| B. CLI e2e: the existing `create-app.spec.ts` boot (or a second one, datasets file naming `RemoteDataset`) fails on any `TWO COPIES` line and asserts 014's `instanceof` | 1 day | regressions of A's class in the template, in CI, on every CLI PR |
| C. Bundle every installed `@_linked/*` but core and the CLI in a standalone app | 1 line; 1 day to verify with the template e2e and webid.email standalone | removes today's 8 to 13 standalone Node copies and webid-email 010 (a); workspace mode still bundles only workspaces and dependents |
| D. Package conventions: module state on `globalThis` under `Symbol.for('@_linked/<pkg>:<name>')` (server-utils' `Server` proxy and `LincdServerProxy.defaultHeaders` are the remaining ones), and an error brand check (`isLinkedError(err, Cls)` via a `Symbol.for` brand) instead of `instanceof` across packages | 1 to 2 days across server-utils, server, core | makes a copy harmless where one slips through: any cause, any runtime |
| E. Per-package copy marker: each package's entry registers `import.meta.url` in a `globalThis` map and warns on a second URL for the same name | 2 to 3 days across about 20 repos, plus the package template | every cause, including browser and prod (optimizer, inlining, localized copies); core already counts copies of its registry and `LinkedStorage` |

A and B are the cheapest way to stop a case reaching a user unnoticed. C removes the live cases.
D limits the damage of the next one. E is the only one that sees the browser and production, at
the highest cost, and cli#272 and cli#177 already guard those paths for the cases seen so far.

## Recommendation

A + B + C, then D:

1. Backlog 014's loader (core + cli, about half a day).
2. A, warning on by default under `linked start`, with an env opt-out (`LINKED_DUAL_COPY_GUARD=0`
   on the spike).
3. C behind the same release, verified by B and by the webid.email standalone `email.spec`.
4. B in the CLI's e2e set.
5. D as a follow-up in server-utils (its two module-level states) and core (the error brand
   helper), so app-template's `isError` and later cases need no name matching.

E waits until a browser or production case recurs that cli#272 and cli#177 do not catch.

## Done when

- `linked start` prints a `TWO COPIES` warning naming the file and its importer when Node loads a
  file of a package the SSR runner bundles, and a unit test covers the matcher (package name only,
  as Vite matches `noExternal`).
- A fresh template app under `linked start` prints no such warning, with FusekiStore and with a
  `RemoteDataset` datasets file, and the CLI e2e fails if it does.
- webid-email backlog 010 (a) is re-measured with C and closed or updated.
