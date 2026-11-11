---
date: 2026-11-11
summary: >
  `linked branch land` built the landed packages in release order, which only counts the
  dependencies a package.json lists, so a package built before the landed build tool
  (`@_linked/cli`) and ran the old one. It now uses build-all's order: the build tool's own
  dependencies, the build tool, then the rest. Patch.
packages: [cli]
---

# 048 — `branch land` builds the build tool first

## Summary

`linked branch land <m>` fast-forwards the owner's checkouts, then runs `npx linked build` in each
landed package. It built them in `dependencyOrder` (the release order), which only follows the
dependencies a `package.json` lists. A package whose build uses the build tool without listing it
(through `npx linked`) sorted by name, so `@_linked/auth` built before `@_linked/cli`, ran the old
CLI, and its ontology check failed. The build now follows the same order as `linked build-all`
(`orderBuildToolFirst`): the build tool's own dependencies, the build tool alone, then every other
package in dependency order. If the build tool fails to build, the rest are not built, since they
would build with a broken tool, and so are not pushed.

## PR

**What changed**

- `src/commands/master.ts`: new `landBuildOrder` puts the landed packages in `dependencyOrder`,
  then splits them with `orderBuildToolFirst` from `lifecycle.ts` (the function `build-all` uses)
  into `before` (the tool's dependencies, then the tool) and `after`. `branchLand` builds in that
  order. When the tool's build fails, each package in `after` is marked `built: false` with a
  message naming the tool, so it is not pushed either.
- `tests/unit/integration/master.test.ts`: two `linked branch land` tests. In the first, auth and
  cli both depend on core only, and the expected builds are core, cli, auth, server. In the
  second, a failed cli build means server is not built.
- Changeset `land-build-order.md` (patch).

**Verification**

- The two new tests without the fix in `master.ts`: `Tests: 2 failed, 23 skipped, 25 total`. The
  order test received `_linked-core, _linked-auth, _linked-cli, _linked-server`.
- With the fix, `jest tests/unit/integration/master.test.ts`: `Tests: 25 passed, 25 total`.
- `npx linked build`: `✔ Build successful`. `tsc --noEmit -p tsconfig-esm.json`: no errors.
- The full unit suite: `Test Suites: 1 failed, 102 passed, 103 total`,
  `Tests: 13 failed, 1256 passed, 1269 total`. All 13 failures are in
  `tests/unit/shapeHierarchy.test.ts`. They fail the same way on unmodified `main` in this worktree
  (`Tests: 13 failed, 5 passed, 18 total`), because the fixture loads the host checkout's localized
  `@_linked/core`. The worktree used a link farm into an app checkout's install, not an install of
  its own. Not related to this change.
- The e2e suite (Playwright, scaffolds and installs an app) was not run. It does not cover `land`.

**Follow-ups**

- `dependencyOrder` (release order) still leaves out the build tool when a package doesn't list it.
  Release PRs and `checkout` also use that order. This change doesn't touch them.
