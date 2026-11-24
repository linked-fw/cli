---
date: 2026-11-11
summary: >
  `linked branch land` built `@_linked/auth` before `@_linked/cli`: the shared dependency order
  hit the core/cli cycle (cli depends on core, core devDepends on cli) and fell back to name order.
  `dependencyOrder` now orders the build tool as build-all does (its dependencies, the tool, the
  rest), and release PRs, checkout and land all use it. Patch.
packages: [cli]
---

# 050 — One dependency order, with the build tool first

## Summary

`linked branch land <m>` fast-forwards the owner's checkouts, then runs `npx linked build` in each
landed package. It works through them in `dependencyOrder`, the order release PRs and `checkout`
use as well. Almost every framework package lists `@_linked/cli` as a devDependency, and the CLI
depends on `@_linked/core`, which devDepends on the CLI. That cycle left no repo ready, so the
order fell back to `rel` order for everything left. `_linked-auth` sorted before `_linked-cli`,
ran the old CLI, and its ontology check failed.

`dependencyOrder` now orders the build tool the way `build-all` does (`orderBuildToolFirst`). Edges
to the build tool count as satisfied. Its own dependencies come first, in dependency order, then
the build tool, then the rest in dependency order, with ties broken by `rel` and the app last.
Release PRs, `checkout` and `land` all share this one order. In `land`, when the build tool fails
to build, the packages after it are not built, since they would build with a broken tool, and so
they are not pushed.

## PR

**What changed**

- `src/commands/release.ts`: `dependencyOrder` handles the build tool (`BUILD_TOOL_PACKAGE` from
  `lifecycle.ts`). It drops edges to the tool, puts the transitive closure of the tool's own
  dependencies first, then the tool, then the rest. Any other cycle still falls back to `rel`
  order.
- `src/commands/master.ts`: `branchLand` builds the landed packages in that order. When the build
  tool's build fails, every package after it is marked `built: false` with a message naming the
  tool.
- `tests/unit/integration/releasePlan.test.ts`: `dependencyOrder` with the real shape. core and cli
  form a cycle, and auth and server devDepend on cli and depend on core. The expected order is core,
  cli, auth, server, app. A second test: a package that does not list the CLI still comes after it.
- `tests/unit/integration/master.test.ts`: land with the same cycle builds core, cli, auth, server.
  When the CLI's build fails, server is not built.
- Changeset `land-build-order.md` (patch).

**Verification**

- The four new tests against `main`'s `release.ts` and `master.ts`:
  `Tests: 4 failed, 36 skipped, 40 total`. Before this fix, the land test received
  `_linked-core, _linked-auth, _linked-cli, _linked-server`.
- With the fix, `npx linked build`: `✔ Build successful`.
- `jest tests/unit/integration/master.test.ts tests/unit/integration/releasePlan.test.ts tests/unit/checkout`:
  `Test Suites: 8 passed, 8 total`, `Tests: 121 passed, 121 total`.
- The full unit suite: `Test Suites: 1 failed, 102 passed, 103 total`,
  `Tests: 13 failed, 1258 passed, 1271 total`. All 13 failures are in
  `tests/unit/shapeHierarchy.test.ts`. They fail the same way on unmodified `main` in this worktree
  (`Tests: 13 failed, 5 passed, 18 total`), because the fixture loads the host checkout's localized
  `@_linked/core`. The worktree used a link farm into an app checkout's install, not an install of
  its own. Not related to this change.
- The e2e suite (Playwright, scaffolds and installs an app) was not run. It does not cover these
  orders.

**Follow-ups**

- None.
