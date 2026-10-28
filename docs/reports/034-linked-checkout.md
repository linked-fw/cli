---
date: 2026-10-27
summary: >
  `linked checkout <branch>` (an app and the packages its `linked.unpublishedPackages` lists, as
  worktrees of bare base clones in a projects root, one install, `--json`), `linked branch fork`,
  `linked branch merge --into <default> [--mode push|update]`, `linked worktree remove --branch`,
  `linked localize --listed`, the `unpublishedPackages(json)` reader and transitive walk, list
  edges in `dependencyOrder`, and credentials only through `LINKED_GIT_TOKEN` (askpass, helpers
  and hooks off, never on disk, never in an install). Step CO of CN master plan 057. Minor.
---

# 034 — `linked checkout`, `branch fork`, `branch merge` (CO)

## PR

### Summary

An app now lists the packages it uses that are not on npm in its committed `package.json`
(`linked.unpublishedPackages`, K-unpublished), and the cli turns that list into checkouts: a
developer's clone with `linked localize --listed`, a server's per-branch checkout with `linked
checkout <branch>` (K-checkout). `branch fork` carries a project branch into a package repo,
`branch merge` lands it in every repo in dependency order, `worktree remove --branch` cleans the
checkout up once landed. A private repo's token comes only from the environment.

### Changes

- `src/installed-packages.ts`: `UnpublishedPackage`, `unpublishedPackages(json, warn?)` next to
  `linkedKind` — normalized `https:`/`file:` URLs, userinfo stripped with a warning, a malformed
  list or entry throws (code 6).
- `src/integration/unpublished.ts`: `walkUnpublished` (breadth first, one checkout per name,
  every `requiredBy`, two repos for one name refused before the install, cycles end),
  `packageBranch` / `appBranch` (the branch rule), `branchDir`.
- `src/integration/credentials.ts` + `hooks/git-askpass.cjs` (`.cmd` twin): `gitRemoteEnv`,
  `remoteEnv`, `localEnv`, `gitRunners`, `stripUserinfo`, `scrubSecret`. Remote git calls get
  `GIT_ASKPASS`, `GIT_TERMINAL_PROMPT=0`, and through `GIT_CONFIG_COUNT` an empty
  `credential.helper` and `core.hooksPath=/dev/null`; pushes add `--no-verify`. Everything else
  runs without the token.
- `src/commands/checkout.ts`: `checkout` (base clones `<root>/.repos/<owner>/<name>.git`, app
  worktree, package worktrees, idempotent re-runs, hooks, one install, builds in dependency
  order, JSON), `checkoutRemove`; `linked checkout` and `worktree remove [agent] --branch` in
  `cli.ts` (`--json` on the agent form too).
- `src/commands/branch-fork-merge.ts`: `branchFork`, `branchMerge` (`push`: `--no-ff` in a
  temporary detached worktree, push `<default>`; `update`: merge `<default>` into the branch,
  push the branch); `linked branch fork`, `linked branch merge`.
- `src/commands/release.ts`: `dependencyOrder` follows `linked.unpublishedPackages` edges.
- `src/localize/localize.ts`: `runLocalize` split into preflight / prepare / finish;
  `localizeListed`; `prepareClone` strips userinfo, clones through the seam, takes a branch;
  installs, builds and the other npm calls run without the token. `--listed` in
  `commands/localize.ts` and `cli.ts`.
- Tests: `tests/unit/checkout/{unpublished,credentials,checkout.e2e,land.e2e}.test.ts`,
  `helpers.ts`, `tests/unit/localize/listed.test.ts`.
- Docs: `README.md`, `docs/integration-branches-and-worktrees.md` (§`linked branch fork`,
  §`linked branch merge`, §`linked worktree remove --branch`, §`linked checkout`,
  §Limitations), `docs/localize.md` (§Commands, §Unpublished packages, §Docker and CI, §What it
  never does, §Exit codes). Sub-plan 002: K-checkout and K-unpublished final, CO ticked. CN (same
  landing): arch-03 §Local development, `docs/how-to/develop-a-linked-package-locally.md`,
  K-checkout and K-unpublished in plans 057 and 180.
- Changeset `.changeset/linked-checkout.md` (minor). semantu-agents PR
  https://github.com/Semantu/agents/pull/29 (workflow, wrapup).

### Verification

- Quick gate (`npx jest --config jest.config.cjs tests/unit/checkout tests/unit/integration/branch.test.ts tests/unit/integration/worktree.test.ts tests/unit/integration/releasePlan.test.ts tests/unit/localize/commands.test.ts tests/unit/localize/resolve.test.ts tests/unit/localize/listed.test.ts tests/unit/linkedKind.test.ts`):
  `Test Suites: 11 passed, 11 total` / `Tests: 160 passed, 160 total`, 34 s wall.
- `npm run test:unit`: before `Tests: 1081 passed` (with a built `lib/`); after
  `Test Suites: 97 passed, 97 total` / `Tests: 1126 passed, 1126 total`, 44 s wall.
- `npm run test:template`: `Test Suites: 2 passed, 2 total` / `Tests: 22 passed, 22 total`, 79 s.
- CN `npm run typecheck:gate`: `No new type errors. 0 pre-existing errors still in the baseline.`
  (15 s). CN's regular set not run: CN changed only docs.
- `npm run build`; `node lib/esm/launch.js checkout --help`, `branch fork --help`,
  `branch merge --help`, `worktree remove --help` show the flags recorded in K-checkout.
- No token on disk: every e2e case ends with `assertNoToken(root)`, which reads every `config` /
  `config.worktree` under the root for the token and for `://…@`, and
  `git config --get-regexp 'remote\..*\.url'` in each base clone. A real `git credential fill`
  proves git asks the askpass hook and not a configured helper; a husky-style `core.hooksPath`
  `pre-push` hook proves no hook runs during a push with the token; the build of each package
  worktree records `none` for `LINKED_GIT_TOKEN`.
- The checkout JSON of the e2e test (temp paths shortened):

```json
{
  "code": 0, "branch": "change-1", "root": "checkout-root-mFwk87",
  "app": {"name": "acme-app", "repo": "file://checkout-remotes-mQIB4x/remotes/acme/acme-app.git",
          "dir": "checkout-root-mFwk87/acme-app/change-1", "branch": "change-1", "created": true,
          "head": "8db30a23a05f0ead0d06733ddcdd0eebc327cfa1", "status": "created"},
  "packages": [
    {"name": "acme-ont", "repo": "file://checkout-remotes-mQIB4x/remotes/acme/acme-ont.git",
     "dir": "checkout-root-mFwk87/acme-app/change-1/packages-local/acme-ont", "branch": "main",
     "detached": true, "fellBack": true, "head": "8e48c183e4359a825d51ae0bc37e3badb446cf77",
     "requiredBy": ["acme-app", "acme-assets"], "status": "created"},
    {"name": "acme-assets", "repo": "file://checkout-remotes-mQIB4x/remotes/acme/acme-assets.git",
     "dir": "checkout-root-mFwk87/acme-app/change-1/packages-local/acme-assets", "branch": "change-1",
     "detached": false, "fellBack": false, "head": "5620907cc72edf10737731bfdd9ebaaddd087106",
     "requiredBy": ["acme-app"], "status": "created"}
  ],
  "install": {"ran": false, "ok": true},
  "builds": [],
  "messages": ["base clone …/.repos/acme/acme-app.git <- file://…/acme-app.git",
               "app: …/acme-app/change-1 on change-1, created from origin/HEAD and pushed",
               "…",
               "acme-ont: …/packages-local/acme-ont detached at origin/main (no change-1 in its repo)",
               "…"]
}
```

- Not run: the by-hand check against a private `linked-cm-testing` repo with an installation
  token (no token was provided to this step).

### Deviations

- `localize --listed` leaves a fallback clone on its default branch, not detached: a full clone
  shares no branch with another worktree. Same branch-rule function.
- A list `repo` must be `https:` or `file:`; anything else is an error.
- The install is automatic (no `--install` flag): created worktrees, moved ones with a manifest
  change, or no `node_modules`.
- `checkout` refuses an app whose `workspaces` lacks `packages-local/*` when its list is
  non-empty, and `branch merge` refuses a repo with commits origin lacks.
- JSON additions: `reason` on `kept`, `unlisted: true`, `repo` and `landed` on every `branch
  merge` entry (the `--mode update` caller opens PRs where `landed` is false), `messages` on
  every result.
- `branch merge` defaults to `--mode push` (master decision); fork and merge live in
  `src/commands/branch-fork-merge.ts`, not `branch.ts`.
- Review fixes beyond the design: git hooks off during remote calls; `worktree remove --branch`
  refuses, even with `--force`, while `packages-local/` holds anything that is not a package
  worktree of the checkout; `origin/HEAD` set on every run; a new app branch a failed run left
  unpushed (no recorded upstream) is pushed by the re-run.
- K-checkout and K-unpublished were updated in 002, 057 and 180 in this landing.

### Follow-ups

- `linked checkout` takes no lock; a squash merge reads as not landed; CO's by-hand check with
  a real installation token was not run — all three homed in CN sub-plan 180 §BC (Known files
  and pitfalls), and the first two in K-checkout.

## Details

**Base clones.** `git clone --bare`, then the fetch refspec
`+refs/heads/*:refs/remotes/origin/*`, the copied local heads deleted, `fetch --prune`, `remote
set-head origin --auto`. The bare repo's own `HEAD` dangles; git does not mind. Every later run
fetches each base clone once and sets `origin/HEAD` again (a renamed default branch otherwise
leaves it pointing at a deleted ref — reproduced in a test).

**Why hooks are off on remote calls.** Askpass needs the token in git's environment, and git
passes that environment to every hook it starts (`pre-push`, `reference-transaction`, `post-
checkout` after a non-bare clone). An app using husky gets `core.hooksPath=.husky` written into
the shared base clone by its `prepare` script, so the next push would run the app's own hook with
the token. `core.hooksPath=/dev/null` through `GIT_CONFIG_COUNT` plus `--no-verify` covers it.
Local git calls (worktree add, merge, switch) keep their hooks: they run without the token.

**Independent review.** One read-only review (credentials, git logic, edge cases) found two high
(hooks see the token; `remove --branch` could delete a full clone inside the app worktree), two
medium (stale `origin/HEAD`; an unpushed new branch never retried) and two low items; all fixed
with a test each, in one iteration. Left low: a locked worktree needs `--force` twice; a
non-fast-forward race on `origin/<into>` between fetch and push is reported as
`push-refused` (the message names both causes; a re-run merges again).

**Commits.** 1f9ba63 (list reader, walk, seam, `--listed`), b093706 (`checkout`), b46a9c8
(`fork`, `merge`, `remove --branch`), f07fde2 (review fixes), then docs, changeset and this
report.
