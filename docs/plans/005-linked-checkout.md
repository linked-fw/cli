---
summary: >
  Step CO of CN master plan 057: `linked.unpublishedPackages` reader and transitive walk,
  `linked localize --listed`, `linked checkout <branch>` (bare base clones, app and package
  worktrees, one install, `--json`), `linked branch fork` / `branch merge` (`--mode push|update`),
  `linked worktree remove --branch`, credentials only through the environment.
status: Implementation
---

# 005 — `linked checkout`, `branch fork`, `branch merge` (CO)

Seeded from [sub-plan 002 §CO](002-package-repos-cli-steps.md#co--linked-checkout-branch-fork-branch-merge)
(scope, design, verify, pitfalls are there and not repeated). Contracts K-unpublished and
K-checkout (002 §Contracts, CN 057 §Contracts).

## Master decisions for this step

- `branch merge` defaults to `--mode push`; `--mode update` (merge `origin/<default>` into the
  branch, push the branch, return the ordered repo list) is for protected default branches.
- Dependency order includes `linked.unpublishedPackages` edges.
- A fallen-back package worktree is detached at `origin/<default>`.

## Refinements inside the design (recorded as deviations in the report)

1. **`localize --listed` fallback stays on the clone's default branch**, not detached: a full
   clone shares no branch with another worktree, which is the only reason for detaching. Same
   branch-rule function (`packageBranch`) decides; only how the fallback is materialised differs.
2. **Repo URLs** in `linked.unpublishedPackages` must be `https:` or `file:` (local repos and
   tests); anything else is an error naming the entry.
3. **Install is automatic** (no `--install` flag): it runs when a worktree was created, moved
   (updated/switched) and `package.json` or `package-lock.json` changed in it, or the app worktree
   has no `node_modules`. Builds run for package worktrees whose head moved.
4. **Local git runs without the token**: only clone, fetch, push, ls-remote and
   `remote set-head --auto` get the askpass environment; every other git and every npm/build gets
   an environment with `LINKED_GIT_TOKEN` (and `LINKED_GIT_USERNAME`) removed, so a hook started
   by `git worktree add` never sees it.
5. **`checkout` refuses an app not set up for checkouts** (`workspaces` lacks `packages-local/*`)
   when its list is non-empty: npm would not link the packages.
6. **`branch merge` refuses up front** when a repo's local `<branch>` has commits `origin/<branch>`
   lacks (it merges `origin/<branch>`; unpushed work would be silently left out).
7. **JSON** gains `reason` on `kept` entries, `unlisted: true` on packages no longer listed, and
   `repo` (clean URL) on every `branch merge` entry, so a `--mode update` caller can open the PRs.
8. **One `checkout` per base clone at a time**: concurrent fetches into one bare clone can fail on
   ref locks; callers (CN's BC) serialise per app. Recorded in K-checkout.

## Phases

### Phase 1 — list reader, walk, branch rule, order edges, credentials seam, `localize --listed`

Tasks:
- `src/installed-packages.ts`: `UnpublishedPackage`, `unpublishedPackages(json, warn?)`
  (validates; normalises with `normalizeGitUrl`; strips userinfo with a warning; throws
  `LocalizeError` code 6 on an invalid entry).
- `src/integration/unpublished.ts`: `walkUnpublished(root, load)` (BFS keyed by npm name, same
  name + repo once with every `requiredBy`, two repos refuse code 6 naming both requirers, cycles
  end), `packageBranch(...)`, `appBranch(...)`, `branchDir(branch)`.
- `src/integration/credentials.ts`: `stripUserinfo`, `gitRemoteEnv(env)`, `remoteEnv(env)`,
  `localEnv(env)`, `scrubSecret(text, env)`; `hooks/git-askpass.cjs` (+ `.cmd`), executable.
- `src/commands/release.ts`: `readDeps` adds `linked.unpublishedPackages` keys.
- `src/localize/localize.ts`: `prepareClone` strips userinfo, clones through `remoteEnv`, takes a
  branch (`packageBranch`); `runLocalize` split into preflight / prepare / finish; new
  `localizeListed(opts, deps)`; `linked localize --listed` in `cli.ts` and `commands/localize.ts`.
- Unit tests: `tests/unit/checkout/{unpublished,credentials,askpass}.test.ts`,
  `releasePlan.test.ts` (edges), `tests/unit/localize/listed.test.ts` (real git, `file://`).

Validation: quick gate green; `npx tsc --noEmit -p tsconfig-esm.json` clean.

### Phase 2 — `linked checkout`

Tasks:
- `src/commands/checkout.ts`: base clones (`.repos/<owner>/<name>.git`, bare, fetch refspec,
  heads deleted, `set-head --auto`), app worktree (branch rule, `--from`, push `-u` on create),
  package worktrees via `walkUnpublished`, idempotency (`created|updated|unchanged|switched|kept`),
  hooks, one install, builds in dependency order, JSON; `runCheckout` and the `checkout` command
  in `cli.ts`.
- `tests/unit/checkout/checkout.e2e.test.ts`: two packages, the asset package listing the
  ontology package, only the asset repo with `change-1`; fallback reported; re-run `unchanged`;
  remote commit → `updated`; branch appears → `switched`; same name two repos refused; no token
  in any config; one real `npm install` case.

Validation: e2e checkout cases green; quick gate green.

### Phase 3 — `branch fork`, `branch merge`, `worktree remove --branch`

Tasks:
- `src/commands/branch.ts`: `branchFork`, `branchMerge` (`push` / `update`, `--no-ff` in a
  temporary detached worktree, conflict stop, later repos `skipped`), commands and `--json`.
- `src/commands/worktree.ts`: `checkoutRemove` (landed against `origin/<default>` after a fetch,
  refuses while any has not landed or has changes, `--force`), `worktree remove [agent]
  --branch`, `--json`.
- e2e cases: fork the fallen-back package; merge ontology, assets, app in order; conflict stops
  at the first repo; update mode pushes branches; remove refused before the merge, removes after.

Validation: full e2e green; `npm run test:unit` green (1081 before).

### Phase 4 — docs, contracts, changeset, skills, review fixes

Tasks: CLI README, `docs/integration-branches-and-worktrees.md`, `docs/localize.md`; CN arch-03
§Local development and `docs/how-to/develop-a-linked-package-locally.md`; K-checkout final flags
and JSON in 002, CN 057 and CN 180; changeset (minor); semantu-agents skills PR; independent
review, fixes.

Validation: `npx linked build`; `--help` of the four commands shows the recorded flags; full gate.

Dependencies: 1 → 2 → 3 → 4 (sequential, one commit each).

## Progress

(updated after each phase)
