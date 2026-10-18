---
date: 2026-10-18
summary: >
  In a standalone app (no workspaces) `linked start` now bundles every `@_linked/*` package but
  core and the CLI for the Vite SSR runner (backlog 015 option C). Measured with the dual-copy
  guard: a fresh template app goes from 8 / 13 `TWO COPIES` lines (RemoteDataset / FusekiStore
  datasets file) to 0 / 0, renders and passes its own e2e; webid.email standalone goes from 17
  lines and a failing `email.spec.ts` (case 17 (a), `LinkedEmail` provider lost) to 0 lines and
  5 passed, given core 2.34.0+; CN (worktree) stays at 0 and its sign-in proof passes. Boot time
  unchanged. Minor release.
---

# 016 — Standalone apps bundle every `@_linked/*` but core and the CLI

## What changed

- `src/vite-config.ts`: `ssrNoExternal([], [])` returns `[STANDALONE_SSR_BUNDLED]`, the exported
  `/^@_linked\/(?!(core|cli)$)/` (anchored: `@_linked/core-x` is bundled, `@_linked/core` is not).
  Before it was `server-utils`, `react` and `SSR_ENTRY_PACKAGES` (`server`). With workspaces it
  returns the same list as before (workspaces, their installed dependents, `@_linked/server`);
  release builds keep `noExternal: []`. The comment at `noExternal` in `createViteConfig` now
  explains the standalone rule and why core and the CLI stay external. The spike's
  `LINKED_SSR_BUNDLE_ALL` variable does not ship.
- `STANDALONE_DEDUPE` (`server-utils`, `react`) and the standalone SSR conditions
  (`module`, `node`, so installed packages resolve to `lib/esm`) are unchanged.
- The store loader (report 014) routes every `@_linked/*` store but core's to `ssrLoadModule` now,
  since they are all bundled; `FusekiStore` named in a datasets file is the runner's copy, the
  same one the app imports.
- `tests/unit/ssrExternal.test.ts`: the standalone list (server, server-utils, react, fuseki,
  schema, primitives, auth and `core-x`/`cli-tools`-style names bundled; core, cli, `react`,
  `sharp`, `@other/core` external), a standalone dev `createViteConfig` uses it with the SSR
  conditions; the workspace cases and the release build case unchanged. 825 unit tests pass.
- README ("Two copies of a framework package"): what the runner bundles in each mode.

## Measured

All with Node v22.23.3 and the dual-copy guard (report 015); "before" is `@_linked/cli@1.50.0`
from npm, "after" this build's `npm pack` tarball, installed into the same app.

### Template app

App-template `main`, created with this build (`create-app probe-d3 --skip-install`), `npm install`,
then `npm install` of the CLI under test and of `@_linked/core@2.35.0` (as in report 015; the
template's lockfile resolves an older core). `linked start` on its own port, its own dataset
(`probe-d3-ssr`, dropped afterwards).

| Datasets file | Before | After | After: boot |
|---|---|---|---|
| RemoteDataset at `http://127.0.0.1:9` | 8 | **0** | `Could not reach the data server at http://127.0.0.1:9`, exit |
| FusekiStore (committed default) | 13 | **0** | `[storage] appData: FusekiStore`, `GET /` 200 |

Every boot printed `[linked] dual-copy guard: on`. Before, the lines were report 015's (the
external `schema` and `primitives` importing the bundled `react` and `server-utils`).

With FusekiStore, after: the `GET /` HTML is server-rendered (the body text has the People
example: "Example code using the @_linked query DSL against your local Fuseki dataset … Add");
`/public/favicon.ico` 200 `image/x-icon`, `/public/favicon-144x144.png` 200 `image/png`,
`/src/index.tsx` 200, `/page1` 200; `[linked] indexed backend providers of 10 linked
package(s) … installed ones with providers: @_linked/server-utils, @_linked/schema,
@_linked/server`; no error in the log. The template's own e2e with this build
(`E2E_PORT=4521 npx playwright test --project template --project data-server-boot`):

```
  ✓  1 [template] › e2e/people.spec.ts:20:1 › People: add, edit and delete a person (2.4s)
  ✓  2 [data-server-boot] › e2e/data-server-boot.spec.ts:124:1 › an unreachable data server stops the boot with its url (1.9s)
  ✓  3 [data-server-boot] › e2e/data-server-boot.spec.ts:134:1 › a refused token stops the boot with the token message (1.6s)
  ✓  4 [data-server-boot] › e2e/data-server-boot.spec.ts:148:1 › an answering data server: the app boots and serves / (2.9s)
  ✓  5 [data-server-boot] › e2e/data-server-boot.spec.ts:169:1 › an empty DATA_SERVER_URL says no data server is set (1.5s)

  5 passed (28.0s)
```

Its teardown left the `-project` dataset behind; it was dropped by hand.

**Boot time**, start of `linked start` to the first `GET /` 200 (FusekiStore) or to the exit
(RemoteDataset), runs interleaved before/after, ms:

| Datasets file | Before | After | Median before → after |
|---|---|---|---|
| FusekiStore | 4288, 3972, 3613 | 3932, 3442, 3073 | 3972 → 3442 |
| RemoteDataset | 2211, 1655, 1646 | 1662, 1669, 1666 | 1655 → 1666 |

No measurable cost. An earlier, non-interleaved set had the first three "after" FusekiStore boots
at 5857 to 6545 ms (and 9775 for the very first, right after install), then 2790 to 3453; the
interleaved set above is the comparison.

### webid.email standalone

A fresh clone of Semantu/webid-email `main` (`f731cee`) in a scratch directory (not the localized
checkout), `npm ci`, the CLI under test installed, `WIE_TEST_PORT=4361 npx playwright test
tests/e2e/email.spec.ts`; the counts are over the run's server logs (`<tag>.log`,
`<tag>-mail.log`, the same per log).

| CLI | `@_linked/core` | `TWO COPIES` | `email.spec.ts` |
|---|---|---|---|
| 1.50.0 (before) | 2.28.1 (lockfile) | 17 | 1 failed, 4 did not run |
| this build | 2.28.1 (lockfile) | 2 | 5 passed |
| this build | 2.35.0 | **0** | **5 passed (20.0s)** |

Before, the failure is backlog 015 case 17 (a): `[mockZeptoMail] no message to lumen-…@example.test`.
The log has `Node loaded @_linked/server-utils/lib/esm/utils/LinkedEmail.js (imported as
"@_linked/server-utils/utils/LinkedEmail" from …/@_linked/auth/lib/esm/utils/email.js)`: auth
(external) sent through Node's `LinkedEmail`, whose provider was never set, and printed a dev
link instead. The 17 files are report 015's 13 plus four reached through `@_linked/auth`
(`LinkedEmail.js`, `components/AppContext.js`, `react/utils/useQueryContext.js`,
`react/utils/Hooks.js`).

With this build and webid.email's locked core 2.28.1 (no store loader, it predates core 2.34.0),
two lines remain, both the datasets file's store loaded by core's native `import()`:

```
[linked] TWO COPIES: Node loaded @_linked/fuseki/lib/esm/shapes/FusekiStore.js (imported as "@_linked/fuseki/shapes/FusekiStore" from ./node_modules/@_linked/core/lib/esm/utils/loadStores.js), but @_linked/fuseki is bundled for the Vite SSR runner. …
[linked] TWO COPIES: Node loaded @_linked/fuseki/lib/esm/utils/datasets.js (imported as "../utils/datasets.js" from ./node_modules/@_linked/fuseki/lib/esm/shapes/FusekiStore.js), but @_linked/fuseki is bundled for the Vite SSR runner. …
```

With core 2.35.0 they are gone. So webid.email needs its core floor raised to `^2.34.0` (a
Renovate bump or a direct one in Semantu/webid-email); until then `FusekiStore` is a Node copy,
as it was before this change, which webid.email only imports as a type.

### CN boot proof

A CN worktree of `main` (`c316c33da`), `npm ci`, the CLI under test installed, then
`CN_TEST_PORT=4079 npx playwright test tests/e2e/signin.spec.ts`. CN is workspace mode
(`packages/*`), so its list is unchanged; the count is the proof.

| CLI | Result | `TWO COPIES` |
|---|---|---|
| 1.50.0 (before) | `5 passed (39.6s)` | 0 |
| this build | `5 passed (33.1s)` | 0 |

```
[globalSetup] CN is healthy on :4079 after 18.3 s
  5 passed (33.1s)
[CN] [linked] dual-copy guard: on
```

**Localized layout not measured, owner's CN was running.** The owner's layout (every framework
package a `packages-local/` checkout, so every one a bundled source workspace) is measured with
the `lib/` overlay into `packages-local/_linked-cli`, which is only run while nothing listens on
:4040; the owner's CN was listening throughout this step. Since this change touches only the
standalone branch of `ssrNoExternal`, and the workspace branch is pinned by the unchanged unit
cases, the localized count is expected to be D2's, which was not measured either.

## Not done here

- The CLI e2e that fails on a `TWO COPIES` line or a guard that is not `on` (option B, CN plan
  068 step D4), which closes backlog 014 and 015.
- webid.email's core floor (`^2.34.0`), above; the webid-email backlog that tracks case 17 (a)
  is updated from this report (Semantu/webid-email).
