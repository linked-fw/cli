---
summary: >
  Sub-plan of Create Now master plan 057 (package repos) for `linked-fw/cli`: LK — one
  `linkedKind(json)` helper and `linked.kind` replacing `linkedPackage`/`linkedApp` in the CLI,
  `@_linked/server` and CN; RK — `linked.kind` in every `package.json` of the CN tree and in
  `linked-fw/app-template`; CO — `linked checkout`, `branch fork`, `branch merge`, credentials
  through the environment, `--json`, docs and skills. Lands on `dev`.
status: Plan
---

# 002 — Package repos: CLI steps

## Master plan

[CN plan 057](../../../../docs/plans/057-package-repo-creation.md) —
`/Users/rene/web/create_now/docs/plans/057-package-repo-creation.md` (rules for every step,
status table, numbers, starter prompt). Steps land on integration branch `dev`.

## Contracts

Copied verbatim from plan 057; the rest are there. A step that changes one updates it here and in
057 in the same landing.

- **K-kind** (provider LK; consumers RK, PC, CO, CN, server): every `package.json` carries
  `"linked": { "kind": "app" | "ontology" | "assets" | "library" }`, merged into an existing
  `linked` object (e.g. `linked.serverOnly`), never replacing it. `linkedPackage` and `linkedApp`
  are gone; no reader accepts them. One helper, `linkedKind(json)` →
  `'app'|'ontology'|'assets'|'library'|undefined`, exported by `@_linked/cli/installed-packages`
  (with `LinkedKind`, `LINKED_KINDS`, `isLinkedPackageJson`); `@_linked/server` keeps a
  byte-identical copy in `@_linked/server/utils/linkedDependencies`, between marker comments that
  name the twin. `discoverLinkedDependencies(appDir, pkg, isLinked?)` takes an optional test; only
  CN's `appPackagesOf` passes one (accepting `linkedPackage: true` too, until the release). A linked package is `kind !== undefined && kind !== 'app'`.
  `ontology` packages may carry shapes for their own terms; `library` is framework code.
- **K-unpublished** (provider CO; consumers PC, BC, RK): an app or package lists the packages it
  uses that are not on npm in its committed `package.json`:
  `"linked": { "unpublishedPackages": { "<npm name>": { "repo": "<https git url>" } } }`.
  Localize follows these lists transitively (an asset package lists its ontology package). A
  published package moves into `dependencies` with a range. One reader, `unpublishedPackages(json)`
  → `[{name, repo}]` from `@_linked/cli/installed-packages`: `repo` is `https:` (or `file:` for
  local repos), userinfo stripped with a warning; a malformed list or entry is an error, never
  skipped. `linked localize --listed` clones the lists in a developer's app; `dependencyOrder`
  reads them as edges.
- **K-checkout** (provider CO, landed; consumers BC, PC, deploy): `linked checkout <branch>
  [--repo <app https url>] [--root <dir>] [--dir <dir>] [--from <ref>] [--no-install]
  [--build <cmd>] [--json]` in a projects root: one bare base clone per repo at
  `<root>/.repos/<owner>/<name>.git`, the app as a `git worktree` on `<branch>` at `--dir`
  (default `<root>/<name>/<branch with / as __>`; created from `--from`, default the remote's
  default branch, and pushed `-u`, when the remote lacks it), the packages of
  `linked.unpublishedPackages` (transitively) as worktrees in its `packages-local/<checkoutNameFor
  name>` on `<branch>` if the package repo has it, else detached at `origin/<default>`
  (`fellBack`); one `npm install` in the app worktree (its own install) when a worktree was created
  or moved with a manifest change, then builds of the moved package worktrees in dependency order;
  an app whose `workspaces` lacks `packages-local/*` is refused. `--json` (also on refusal):
  `{code, branch, root, app: {name, repo, dir, branch, created, head, status, reason?},
  packages: [{name, repo, dir, branch, detached, fellBack, head, requiredBy, status, reason?,
  unlisted?}], install: {ran, ok}, builds: [{name, result: ok|failed|skipped}], messages}`;
  `status` ∈ `created|updated|unchanged|switched|kept`; exit 0, 2 usage, 4 remote unreachable,
  5 build failed, 6 refused, 7 install failed. Re-runs fast-forward clean worktrees, switch a
  fallback whose branch appeared, push a new app branch a failed run left unpushed, and report the
  rest `kept`; nothing is deleted. One run per base clone at a time (callers serialise per app).
  `linked branch fork <branch> <package> [--dir <app>] [--json]`: create the branch in that
  package checkout from its current head and push it; `{code, package, dir, branch, from,
  pushed, messages}`. `linked branch push <branch> [--dir <app>] [--json]`: in every repo of the
  checkout on `<branch>` (the app, which must be on it, and each package worktree on it), fetch and
  push what origin lacks (`-u` when new); a diverged branch is `refused`, never forced; `{code,
  branch, repos: [{name, dir, repo, result: pushed|up-to-date|refused, sha}], messages}`, exit 0,
  2, 4, 6. `linked branch merge <branch> --into <default> [--mode push|update]
  [--dir <app>] [--json]`: the repos on `<branch>`, packages in dependency order (including
  `linked.unpublishedPackages` edges), then the app; fetch; `push` (default) merges
  `origin/<branch>` `--no-ff` into `origin/<default>` in a temporary worktree and pushes
  `<default>`; `update` (protected default branches) merges `origin/<default>` into `<branch>` and
  pushes the branch, and CN (step BC) then opens and merges one PR per repo whose `landed` is
  false, in the order returned, with its GitHub App (0 approvals); stop at the first conflict or
  refused push. `{code, branch, into, mode, repos: [{name, dir, repo, result:
  merged|up-to-date|conflict|push-refused|skipped, sha?, files?, landed}], messages}`.
  `linked worktree remove --branch <branch> [--dir <app>] [--force] [--json]`: remove the
  checkout once every repo has landed in `origin/<default>` (an ancestor of it: a squash merge
  reads as not landed, so CN lands with merge commits); `{code, removed, kept: [{dir,
  reason}], branches: [{repo, branch, deleted, sha}], messages}`. Credentials only through the
  environment: `LINKED_GIT_TOKEN` (and `LINKED_GIT_USERNAME`, default `x-access-token`), used by
  remote git calls through `GIT_ASKPASS` with credential helpers and git hooks off; local git, the
  install and builds run without it; no token is ever written to `.git/config` or any file.
- **K-repos** (provider PC; consumers BC, CS): package repos `{ws}-ont-{slug}` and
  `{ws}-assets-{slug}` in `GITHUB_TARGET_ORG` (production `create-now-repos`, dev/test
  `linked-cm-testing`); npm names `{slug}-ont`, `{slug}-assets`; created with `linked.kind` and the
  asset package listing the ontology package in its `linked.unpublishedPackages`. The app is created
  from the template and works without its packages; CN then opens and merges (as its GitHub App,
  0 approvals) a PR adding both to the app's `linked.unpublishedPackages`. Failure leaves a working
  app and a retry path. The app's `packages/` directory is no longer used for packages.

  (CO's `linked checkout` must handle the K-repos layout; the CLI does not create the repos.)

## Landing LK and RK together

After LK, the CLI and `@_linked/server` read only `linked.kind`. Every local checkout whose
`package.json` still says `"linkedPackage": true` then stops being a linked package for the
owner's running CN: it drops out of boot loading, the ontology sync
(CN `src/backend/infra/cnMainOntologySync.ts:20-27`), Vite's dependency exclusion and
`build-all`. So **RK runs right after LK in the same wave, and LK does not land until RK is
ready.** The master spawns both together; RK works on a worktree branch rebased on LK's branch,
and they land back to back (LK first, RK immediately after, then the main-checkout rebuilds and
one CN restart). Neither lands alone.

## LK — `linked.kind` through one helper

**Depends on:** nothing (wave 1, parallel with CK and WC); lands only together with RK (above).
**Repos:** cli, server, CN (its readers and tests of the flags). **Plan doc:** cli
`docs/plans/003-…`. **Reports:** cli `docs/reports/032-…`, server `docs/reports/020-…`.
**Test port:** 4342. **Size:** medium, 2 phases: (1) the helper and every reader in the CLI and
server, with tests; (2) the writers (templates, `buildPackageFiles`, the identity stampers), CN's
reader and tests, docs.

**Goal.** K-kind: `linkedKind(json)` is the only way anything decides what a package is; nothing
reads `linkedPackage` or `linkedApp`; everything the CLI or CN scaffolds writes `linked.kind`.

**Scope.**
- `linkedKind(json)` in the CLI (next to today's `isLinkedPackageJson`,
  `src/installed-packages.ts`, exported as `@_linked/cli/installed-packages` or a new
  `@_linked/cli/utils/linkedKind` — record the path in K-kind); `isLinkedPackageJson` becomes
  `kind !== undefined && kind !== 'app'` on top of it (keep the name or replace its callers; one
  definition either way). An app check is `linkedKind(json) === 'app'`.
- The byte-identical copy in `@_linked/server/src/utils/linkedDependencies.ts`, with a test in
  each repo comparing it with the other's source text, or a comment naming the twin (pick one, say
  which in the report).
- Every reader (Files) switched. `shapeHierarchy.ts:103`'s scope fallback
  (`name.startsWith('@_linked/') ||`) stays only if a test needs it; report it.
- Writers: `defaults/package/package.json` and the per-kind `buildPackageFiles` write
  `"linked": {"kind": "ontology"}` / `{"kind": "assets"}`; the react-native template writes
  `assets` for `packages/app-shapes` (shapes only, no ontology) and `app` for `services/api`. The app identity stampers write `"linked": {"kind": "app"}` and drop
  `linkedApp`, merging into an existing `linked` object: CLI `applyAppIdentity`
  (`src/cli-methods.ts:608`) and CN `stampAppIdentity` (`src/backend/provisioners/appTemplateIdentity.ts`).
  That way an app made from the published `linked-fw/app-template` (which keeps `linkedApp: true`
  until RK's template branch is released) is right from the start.
- CN: `appTemplateIdentity.ts:92-94` refuses a template whose kind is not `app`/absent the way it
  refuses `linkedPackage` today; CN tests that write or assert the flags (Files).
- Changesets: cli (minor), server (minor). CN has none.
- Not here: the `package.json` of existing packages (RK); `linked.unpublishedPackages` (CO).

**Verify.**
- `git -C packages-local/_linked-cli grep -nE '\.linkedPackage\b|linkedPackage ?(===|:) ?true|"linkedPackage"|linkedApp' -- src defaults`
  and the same in `_linked-server/src` and CN `src` find only `linkedPackage(` registration calls
  and comments that explain the old field is not read.
- cli `npm run test:unit` and `npm run test:template`; server's jest suite; CN gate (Tests).
- With RK applied (the joint landing), in the main checkout: `npx linked build-all` builds every
  package it built before (compare the package list with one taken before LK); restart CN on
  :4040 and check the boot log lists the same linked packages and ontology sync packages as
  before; the owner's path (sign in, open a project and its Ontology Manager) works.

**Done when.** One helper and its server twin; zero readers of the old fields; scaffolds and both
identity stampers write `linked.kind`; cli, server and CN gates green; changesets in cli and
server; landed back to back with RK.

### Files (found in the code)

CLI (`packages-local/_linked-cli`), readers:
- `src/installed-packages.ts:60-70` — `isLinkedPackageJson` (the helper today, JSDoc `:60-68`);
  its uses: `:110`, `src/utils.ts:240`, `src/commands/build-package.ts:28` (message `:33`),
  `src/lifecycle.ts:396,611`, `src/vite-config.ts:802` (`installedLinkedDeps`).
- `src/lifecycle.ts:397` — `isApp: pack.linkedApp === true` (field docs `:229-238,254,275,573`).
- `src/cli-methods.ts:3011-3012` — `isPackage` / `isApp` guard of `linked build` (messages
  `:3017,3023`; comments `:106-108,585,993,3005,3165`).
- `src/client-dep-includes.ts:683,746` (`installed.json.linkedPackage`; header `:5`).
- `src/utils/shapeHierarchy.ts:103` (scope or flag).
- `src/localize/app-root.ts:38,47` (`linkedPackage` field of the manifest read), used `:56,63,72,95-98`.
- `src/utils/createPackageLocation.ts:66,77,114` (finds the app by `linkedApp: true`).
- Comments only: `src/vite-config.ts:370,387,792,838`.
- Not this: `linkedPackage('<name>')` regexes in `src/utils/shapesTurtle.ts:48-54`,
  `src/utils/shapeReferences.ts:262-268`, `src/utils/shapeHierarchy.ts:92-98`,
  `src/utils/packageBaseUri.ts:99-108`, `src/cli.ts:172` — core's registration call, unchanged.

CLI writers:
- `defaults/package/package.json:14`; `src/utils/packageFiles.ts:169-253` (`buildPackageFiles`,
  per `ScaffoldKind` from `src/utils/packageKind.ts:17-21`: `ontology` | `assets`);
- `defaults/app-react-native/packages/app-shapes/package.json:6`,
  `defaults/app-react-native/services/api/package.json:6`;
- `src/cli-methods.ts:264` clones `linked-fw/app-template` (its `package.json` is RK's);
  `applyAppIdentity` `:608`.

CLI tests and fixtures that assert or write the flags (`git grep -lE 'linkedPackage|linkedApp' tests`):
`tests/unit/createPackageScaffold.test.ts:81,85,142,145,163,175,192,238,243,262` (`:85,145`
check the `linkedPackage('…')` call: keep), `createPackageLocation`, `createInsidePackage`,
`buildAllDiscovery`, `buildAllBuildToolFirst`, `buildAllFailure`, `clientDepIncludes`,
`app-doctor`, `discoverWorkspacePackages.localized`, `discoverWorkspaces(.localized)`,
`createApp.identity`, `createApp.reactNative`, `doctorResolve`, `linkedDependencySort`,
`localize/app-root`, `localize/adopt`, `localize/commands`, `ssrExternal`, `viteDedupe`,
`workspaceNegatedPatterns`, `esmSpecifiers`, `shapeHierarchy`, `packageFiles`, and others the
grep lists (some only use the registration call); `tests/template/react-native.full.test.ts`;
fixtures `tests/fixtures/ontology-app/{app,installed/probe-ont,workspace/ws-ont}/package.json`,
`tests/fixtures/ontology-generator/package.json`.

Server (`packages-local/_linked-server`, on `dev`):
- `src/utils/linkedDependencies.ts:36-39` (`isLinkedPackageJson`, JSDoc `:20-35`), used `:121,146`.
- `src/shapes/LinkedServer.tsx:397-398` — comment only (`linkedPackageDirs`).
- Tests: `src/tests/boot-installed-providers.test.ts`, `nested-linked-packages.test.ts`,
  `shape-graphs-live.test.ts`, `fatal-provider-errors.test.ts`, `has-module-entry.test.ts`.
- `package.json:93` already has `"linked": {"serverOnly": […]}` (also `_linked-server-utils`
  `package.json:41`, read by CN `src/__tests__/clientBoundary.test.ts:100`): RK merges `kind`
  into these.

CN (`/Users/rene/web/create_now`):
- `src/backend/provisioners/appTemplateIdentity.ts:18,38,82,92-94` (the refusal and comments).
- `src/backend/infra/cnMainOntologySync.ts:20-27` and `src/backend/gateway/graphAccess.ts:155-168`
  (`appPackagesOf`) — use the server's `discoverLinkedDependencies`; no change, but they are what
  breaks if RK is missing (above) — and see Pitfalls for app clones.
- `src/backend/provisioners/appProjectPackages.ts:22,51,57,118,132-133,299` — uses
  `buildPackageFiles`; its scaffolds get `linked.kind` from the CLI.
- Tests: `appTemplateIdentity.test.ts:9,33,40-41,93-94,104`,
  `appProjectPackages.test.ts:30,48,111,191-230`, `ProjectCreationOrchestrator.test.ts:510-550`,
  `gateway/graphAccess.test.ts:136-147`.

### Pitfalls

- **Merge, never replace, the `linked` object**: server and server-utils already have
  `linked.serverOnly`. `buildPackageFiles` and the stampers must spread an existing `linked`.
- **LK and RK land together** (§Landing LK and RK together). Do not land LK alone, even with green
  tests: the tests use fixtures, the owner's CN uses the real checkouts.
- **App clones install `@_linked/*` from npm.** CN's managed app clones (`CN_PROJECTS_ROOT`) get
  their framework packages from npm, published with `linkedPackage: true` only until the release.
  CN's own `@_linked/server` (localized, with LK) runs `discoverLinkedDependencies` over a clone in
  `graphAccess.appPackagesOf` (`graphAccess.ts:158-168`), so it finds none of the clone's npm
  framework packages until they are republished. The clone's own server (from npm) is unaffected.
  Check what `appPackagesOf` loses on the owner's project (the framework packages' graph roots)
  before landing; if the owner's path breaks, stop and report — the master decides (K-kind says
  no reader accepts the old fields).
- `isFrameworkPkg(name)` in `client-dep-includes.ts:683` is a separate name check; keep it.
- `localize/app-root.ts` keeps `linkedPackage: boolean` as a field name of its own manifest type;
  rename it (`isPackage`) so no field of that name survives.
- Build the CLI and server with `npx linked build`, never `tsc`; the CN worktree loads them from
  the nested worktrees (`npx linked doctor resolve` shows `overlay`).

### Architecture

- CN arch-03 §Package types (`docs/architecture/03-packages-and-governance.md:15`), §The CN
  workspace model and §Local development with `linked localize` (`:684,719`): the `linked`
  object; update where it names `linkedPackage`/`linkedApp`.
- cli `docs/architecture/vite-runtime-config.md` (Vite exclusion of linked packages), server
  `docs/architecture/01-server-only-surface.md` (`linked.serverOnly`).
- CLI README (`linked build` / `create-package` sections) and `docs/localize.md`.

### Tests

- **Quick gate (1–2 min):** cli
  `npx jest --config jest.config.cjs tests/unit/createPackageScaffold.test.ts tests/unit/createPackageLocation.test.ts tests/unit/buildAllDiscovery.test.ts tests/unit/clientDepIncludes.test.ts tests/unit/shapeHierarchy.test.ts tests/unit/packageFiles.test.ts tests/unit/createInsidePackage.test.ts`;
  server
  `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs src/tests/boot-installed-providers.test.ts src/tests/nested-linked-packages.test.ts`;
  CN `npx vitest run src/backend/provisioners/appTemplateIdentity.test.ts src/backend/provisioners/appProjectPackages.test.ts src/backend/gateway/graphAccess.test.ts`.
- **Full gate:** cli `npm run test:unit`, `npm run test:template`, `npx linked build`; server
  full jest suite and `npx linked build`; CN `npm run typecheck:gate` and
  `CN_TEST_PORT=4342 npm run test:regular`.
- New tests: `linkedKind` for each kind, absent, a non-string, and the old fields alone
  (→ `undefined`); `buildPackageFiles` keeps an existing `linked` key; both stampers turn
  `linkedApp: true` into `linked.kind: "app"`.

## RK — `linked.kind` in every `package.json`

**Depends on:** LK (runs with it in the same wave; rebases on LK's branch; lands right after it).
**Repos:** every `_linked-*` checkout, CN, `semantu-webid-email`, `linked-fw/app-template`.
**Plan doc:** cli `docs/plans/004-…`. **Report:** cli `docs/reports/033-…`. **Test port:** 4344.
**Size:** medium (wide, mechanical), 2 phases. *Plan-mode detail is added when its wave starts.*

**Goal.** K-kind holds for every `package.json` in the CN tree and in the app template: the old
fields gone, `linked.kind` set, so the owner's CN after LK loads exactly what it loaded before.

**Scope.**
- `linkedApp` → `app` (3): CN root, `packages/my-app`, `packages-local/semantu-webid-email`.
- CN `packages/` (4) → `library`: access, documents, maps, execution-gateway. `packages/editor-chrome`
  has neither field today: leave it unmarked unless the agent finds a reader needs it (report).
- `packages-local/_linked-*` (22): ontology — dcat, dcmi, org, owl, rdfs, schema, sioc, xsd (and
  npm, whose `linkedPackage: true` CK added); library — core, react, server, server-utils, cli,
  css, icons, fuseki, s3, sentry, shape-ui, primitives, translation, auth. Merge into existing
  `linked` objects (server, server-utils).
- On `dev` already: auth, cli, core, dcat, fuseki, primitives, server, server-utils, and
  `semantu-webid-email`. The other 13 `_linked-*` checkouts (css, dcmi, icons, org, owl, rdfs,
  react, s3, schema, sentry, shape-ui, sioc, translation, xsd) join `dev`
  (`npx linked branch start dev <pkg> --target main` from CN's main checkout), plus npm (local).
- `linked-fw/app-template` (remote only) → `app`: clone it to a working dir, branch `dev` from its
  `main`, commit, never push (the release opens its PR).
- One changeset per framework repo (patch: metadata only).
- pg-cn and its `@linked.cm/*` packages: a backlog item in pg-cn
  (`/Users/rene/web/pg-cn/docs/backlog/`, next free number), no changes.

**Done when.** `git grep -nE '"linkedPackage"|"linkedApp"' -- '*package.json'` finds nothing in
the CN tree (outside `node_modules`) or the template branch; every checkout has its changeset;
build-all and the boot log list the same packages as before LK; the pg-cn backlog item exists.

**Known files and pitfalls.**
- 29 `package.json` carry a flag today (`grep -l '"linkedPackage"\|"linkedApp"' package.json packages/*/package.json packages-local/*/package.json`).
- Lockfiles: changing `package.json` metadata only must not change dependencies; never commit a
  lockfile that lists `packages-local/`.
- The release republishes every package with `linked.kind`; until then npm-installed copies (app
  clones, CI) carry only the old field (LK §Pitfalls).

## CO — `linked checkout`, `branch fork`, `branch merge`

**Depends on:** LK and RK (landed; CO rebases on them, all touch the CLI). **Repo:** cli (+ CN
docs, semantu-agents skills PR). **Plan doc:** cli `docs/plans/005-…`. **Report:** cli
`docs/reports/034-…`. **Test port:** 4345 (only if a CN run is needed; the CLI gates need none).
**Size:** large, 4 phases (below). **Sensitive** (credentials): independent review before landing.

**Goal.** K-unpublished and K-checkout: one command makes a branch checkout of an app and its
unpublished packages as git worktrees of base clones, with credentials only in the environment;
two commands mirror a project branch into a package repo and merge it back; `worktree remove`
cleans such a checkout up once it has landed.

### Scope

- **The list reader** (K-unpublished): `unpublishedPackages(json)` next to `linkedKind` in
  `src/installed-packages.ts` (same module, exported from `@_linked/cli/installed-packages`):
  validates `linked.unpublishedPackages` (`{ "<npm name>": { "repo": "<https url>" } }`), returns
  `[{name, repo}]` with the repo normalized (`normalizeGitUrl`, userinfo stripped); invalid entries
  are errors, not skipped. A transitive resolver over it (Design §Transitive list).
- **`linked localize --listed`**: in a developer's app, clone every package of the app's list
  (transitively) that is not in `packages-local/` yet, on the app's branch with fallback (Design
  §Branch rule), then the usual one install and builds (`installAndBuild`). Full clones as today
  (a developer's app is one checkout); `prepareClone` takes a `branch` and runs the clone through
  the credentials seam. Bare `linked localize` keeps reporting.
- **`linked checkout <branch>`** (K-checkout), new top-level command next to `worktree add`, not
  instead of it.
- **`linked branch fork <branch> <package>`** and **`linked branch merge <branch> --into
  <default>`** under the existing `branch` command.
- **`linked worktree remove --branch <branch>`**: removes a `linked checkout` checkout (the app
  worktree and its package worktrees) after checking each repo's branch landed in that repo's
  default branch (`origin/<default>` after a fetch); `<agent>` becomes optional when `--branch`
  is given.
- **Credentials seam**: every `git` that talks to a remote (clone, fetch, push, ls-remote) in the
  new code and in `localize`'s clone goes through one helper that adds the askpass environment;
  no URL with userinfo ever reaches `git clone`, `git remote` or a config file (Design
  §Credentials).
- `--json` on `checkout`, `branch fork`, `branch merge` and `worktree remove`.
- `dependencyOrder` (`src/commands/release.ts:182`) also follows `linked.unpublishedPackages`
  edges (an asset package lists its ontology package there, not in `dependencies`); `release
  plan`'s order gains the same edges.
- Docs and skills (Architecture). K-checkout here and in CN 057/180 gets the final flag names and
  JSON shape in the same landing.
- Not here: creating repos (PC), CN's `CheckoutProvisioner` switch (BC), opening PRs on GitHub.

### Design (proposal; the step agent may refine it inside K-checkout, K-unpublished, K-kind)

**Command line.**
```
linked checkout <branch> --repo <app https url> [--root <dir>] [--dir <dir>] [--from <ref>]
                [--no-install] [--build <cmd>] [--json]
linked branch fork <branch> <package> [--dir <app checkout>] [--json]
linked branch merge <branch> --into <default> [--dir <app checkout>] [--mode push|update] [--json]
linked worktree remove --branch <branch> [--dir <app checkout>] [--force] [--json]
```
`--root` defaults to the current directory; `--repo` may be left out when run inside an existing
app checkout (it is that checkout's `origin`). `<package>` is matched like `branch start` does
(`@_linked/core`, `core`, `_linked-core`, or the plain npm name `acme-ont`).

**Projects-root layout.**
```
<root>/.repos/<owner>/<name>.git                  bare base clone, one per repo (app and packages)
<root>/<name>/<branch-dir>/                       app worktree (default --dir)
<root>/<name>/<branch-dir>/packages-local/<dir>/  package worktree, <dir> = checkoutNameFor(npm name)
```
`<owner>/<name>` from the normalized URL path (two orgs never collide); `<branch-dir>` is the
branch with `/` → `__` (the CN caller passes `--dir` with its own `branchClonePath`, so CN's
layout stays CN's). A base clone is a plain `git clone --bare` (not a partial clone: that needs
the remote at every later checkout); then
`git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`, delete the copied local
heads, `git fetch --prune origin`, `git remote set-head origin --auto`. Every worktree's branch is
then a local branch tracking `origin/<branch>`, and the default branch is `origin/HEAD`.

**Branch rule** (one function, used by `checkout` and `localize --listed`):
- The app: `<branch>` if `origin/<branch>` exists; else create it from `--from` (default
  `origin/HEAD`), push it `-u`, report `created: true`. A local branch of that name already in
  another worktree → refuse that repo (git allows a branch in one worktree only).
- A package: `<branch>` if the package repo has `origin/<branch>`; else **detached at
  `origin/<default>`**, `fellBack: true`. Detached, not on `main`: two branch checkouts that both
  fall back would otherwise both need `main` checked out, which git refuses. `branch fork` turns a
  detached fallback into the branch.

**Transitive list.** Breadth first from the app worktree's committed `package.json` (the branch
actually checked out): for each `{name, repo}` not yet seen, make its base clone and worktree, then
read *that worktree's* `package.json` (the package's branch, or its default when it fell back) and
queue its list. Keyed by npm name: the same name with the same normalized repo is checked out once
and records every `requiredBy`; the same name with two different repos refuses (exit 6) before
anything is installed, naming both requirers. Cycles end through the seen set. A listed name the
worktree's `package.json` declares with another `name` refuses (the repo is not that package). A
name also in the app's `dependencies` is a warning (it is published: K-unpublished says it moves
out of the list).

**Install.** One `npm install --no-audit --no-fund` in the app worktree after every package
worktree exists (the `INSTALL_ARGS` of `localize.ts:76`), then builds of the package worktrees
that have a build script (cli first, as `installAndBuild` does; `--build ''` builds nothing). The
app worktree has its own `node_modules` (never the link farm: `refuseSharedInstall`,
`localize.ts:641`, keeps applying). The app's `postinstall` runs `hooks/lock-at-rest.cjs`, which
restores the committed `package-lock.json`, so `git status` in the app worktree stays clean while
`packages-local/*` members exist; `checkout` installs the localize git hooks
(`installGitHooks`) in the app's base clone so they cover its worktrees (check `core.hooksPath`
and worktree-shared hooks in a test). The docs say plainly: this is an app's own install, not CN's
workspace and not an agent worktree's link farm. `--no-install` skips both install and builds.
`LINKED_GIT_TOKEN` is removed from the environment of `npm install` and every build (lifecycle
scripts must not see it).

**Idempotency.** Re-running `checkout` with the same branch: fetch every base clone (`--prune`);
the app worktree exists → clean and behind → `merge --ff-only origin/<branch>`; dirty or diverged
→ left alone, `status: "kept"` with the reason. A fallen-back package whose repo now has the
branch and is clean → switched to it (`switched: true`); a package on its branch → ff as the app;
a newly listed package → added; a package no longer listed → left, reported `unlisted: true`
(never deleted). The install runs only when a worktree was created, moved or a `package.json` /
lockfile changed (or always with `--install`, if the agent finds `auto` unreliable — say which).

**JSON** (`checkout --json`, printed on success and on refusal; exit code also in `code`):
```json
{
  "code": 0,
  "branch": "change-1",
  "root": "/srv/projects",
  "app": {"name": "acme-peacegame-app", "repo": "https://github.com/create-now-repos/acme-peacegame.git",
          "dir": "/srv/projects/acme-peacegame/change-1", "branch": "change-1", "created": true,
          "head": "3f2c…", "status": "created"},
  "packages": [
    {"name": "peacegame-ont", "repo": "https://github.com/create-now-repos/acme-ont-peacegame.git",
     "dir": "/srv/projects/acme-peacegame/change-1/packages-local/peacegame-ont",
     "branch": "main", "detached": true, "fellBack": true, "head": "a91e…",
     "requiredBy": ["acme-peacegame-app", "peacegame-assets"], "status": "created"},
    {"name": "peacegame-assets", "repo": "https://github.com/create-now-repos/acme-assets-peacegame.git",
     "dir": "…/packages-local/peacegame-assets", "branch": "change-1", "detached": false,
     "fellBack": false, "head": "77b0…", "requiredBy": ["acme-peacegame-app"], "status": "updated"}
  ],
  "install": {"ran": true, "ok": true},
  "builds": [{"name": "peacegame-ont", "result": "ok"}],
  "messages": []
}
```
`status` ∈ `created | updated | unchanged | switched | kept`. `branch fork --json`:
`{code, package, dir, branch, from: <sha>, pushed: true}`. `branch merge --json`:
`{code, branch, into, mode, repos: [{name, dir, result: "merged"|"up-to-date"|"conflict"|"push-refused"|"skipped", sha?, files?}]}`
in merge order. `worktree remove --json`: `{code, removed: [dir…], kept: [{dir, reason}], branches: [{repo, branch, deleted, sha}]}`.

**Credentials.** The CLI ships `hooks/git-askpass.cjs` (plain CommonJS like the other hooks,
executable, a `#!/usr/bin/env node` line; a `.cmd` twin on Windows, `src/localize/run.ts` already
knows the platform rules): it answers a `Username` prompt with `x-access-token` (or
`LINKED_GIT_USERNAME`) and a `Password` prompt with `LINKED_GIT_TOKEN`, and exits 1 when the
variable is unset. One helper `gitRemoteEnv(env)` returns, only when `LINKED_GIT_TOKEN` is set,
`GIT_ASKPASS=<that file>`, `GIT_TERMINAL_PROMPT=0` and, through `GIT_CONFIG_COUNT`/
`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, an empty `credential.helper` (so a keychain helper never
*stores* the token git just used) — no `-c` on argv, so no token or helper in `ps`. Every URL the
CLI receives is stripped of userinfo before use; one with userinfo is accepted only to strip it,
with a warning (CN passes a clean URL plus the env). Error text from git is scrubbed of the token
value before it is printed. A test greps every `config` and `worktrees/*/config*` under the root
for the token and for `@github.com`.

**`branch fork <branch> <package>`.** In the app checkout's `packages-local/<dir>`: refuse when
dirty or the branch already exists on `origin`; `git switch -c <branch>` from the current head
(the detached fallback), `git push -u origin <branch>`. A local branch that exists unpushed → push
it. Idempotent: on `<branch>` already and pushed → `pushed: false`, code 0.

**`branch merge <branch> --into <default>`.** In the app checkout: the repos on `<branch>` (the
app and each package worktree whose branch is `<branch>`; fallen-back packages are skipped), in
`dependencyOrder` (packages first, the app last, with the `unpublishedPackages` edges). Per repo:
`git fetch origin`; refuse up front, for all repos, when any is dirty. Then per repo in order:
`git merge --no-ff origin/<branch>` in a temporary detached worktree of the base clone at
`origin/<default>` (`git worktree add --detach`, removed after; the checkout itself stays on
`<branch>`), commit message
`Merge branch '<branch>' into <default>`, then `git push origin HEAD:<default>`. **`--no-ff`**:
one merge commit per repo is the record of "project branch X was merged", reverts as one commit,
and works when `<default>` moved on (ff-only would refuse). Stop at the first conflict (`git merge
--abort`, `result: "conflict"` with the files, later repos `skipped`, exit 6); repos already
pushed stay merged (a package merged before the app is harmless: the app's `<default>` still reads
the package's `<default>`, now with the change). `--mode update` instead merges `origin/<default>`
into `<branch>` in each repo and pushes `<branch>`, so a caller that may not push to `<default>`
(protected: see Pitfalls) can land by PR; the step agent picks the default mode with the master.

**`worktree remove --branch <branch>`.** Finds the app worktree by `--dir` or by `<branch>` among
the base clone's worktrees; fetches; per repo, landed = `git merge-base --is-ancestor <branch>
origin/<default>` (a fallen-back detached package counts as landed; its HEAD is on `<default>`'s
history); refuses, removing nothing, while one has not landed or has changes (`--force` as today);
removes package worktrees, then the app worktree (`git worktree remove`, then `git worktree prune`
in each base clone), then deletes the landed local branches. Base clones stay. The `landed()` of
agent worktrees (`commands/worktree.ts:395-399`, against the local base) is unchanged.

### Verify

- `cd packages-local/_linked-cli && npx jest --config jest.config.cjs tests/unit/checkout tests/unit/integration tests/unit/localize`
  green; `npm run test:unit` green (count before/after quoted).
- The e2e test (Tests) prints the checkout JSON; quote it in the report.
- No token on disk after the e2e test:
  `grep -rl "$LINKED_GIT_TOKEN" <tmp root> --include=config --include='config.worktree'` and
  `git -C <base clone> config --get-regexp 'remote\..*\.url'` show no token or userinfo (the test
  asserts both).
- `npx linked build` in the cli; `node lib/esm/launch.js checkout --help`, `branch fork --help`,
  `branch merge --help`, `worktree remove --help` show the flags recorded in K-checkout.
- By hand, once, against a private repo of `linked-cm-testing` with an installation token in
  `LINKED_GIT_TOKEN` (the master gets the token from CN's testing App key; skip and say so if not
  available): `linked checkout test-co --repo <url> --root $(mktemp -d) --json`, then
  `grep -r x-access-token <root>` finds nothing.
- CN main checkout after landing and `npm run build` in the cli: `npx linked branch status` and
  `npx linked worktree list` unchanged; the owner's path works.

### Done when

K-unpublished and K-checkout hold, with the flag names and JSON shape recorded here and in CN
057/180; the e2e test makes a checkout of an app with two unpublished packages (the asset package
listing the ontology package; one package only on the default branch: fallback reported), re-runs
it idempotently, forks the fallen-back package's branch, merges package then app into the default
branch, removes the checkout with the landed check; no `config` under the root holds a token;
`localize --listed` clones from the list in one install; cli gates green; changeset (minor);
docs updated; semantu-agents PR open; independent review findings fixed.

### Files (found in the code)

CLI (`packages-local/_linked-cli`):
- Commands: `src/cli.ts:574-622` (`localize`, `--repo` `:597`), `:669-696` (`branch status`,
  `branch start`; `fork`/`merge` go here), `:697-753` (`worktree add` `:703-717`, `list --json`
  `:718-729`, `remove <agent>` `:730-742`, `relink` `:743-753`), `:754-770` (`release plan`).
  `checkout` is added next to the `worktree` block.
- `src/commands/worktree.ts` (841 lines): `worktreeAdd` `:125` (refuses an existing dir `:135`,
  `baseOf` `:102-107` needs a branch, `agentBranch` from `src/integration/repos.ts:178-185`
  always `<base>--<agent>`), `landed()` `:395-399` (against the local base, no fetch),
  `worktreeList` `:443`, `findAppWorktree` `:530`, `worktreeRemove` `:575` (refusal `:613-628`,
  branch deletion `:694-704`), `runWorktreeRemove` `:829-841`.
- `src/commands/branch.ts` (439 lines): `refExists` `:50`, `localBranchExists` `:57`,
  `safeToDeleteCreatedBranch` `:77`, `parseWorktreeList`/`worktreesOf` `:111,128`,
  `selectCheckouts` `:245` (package matching for `fork`), `branchStart` `:291`, `runBranchStatus`
  `:422` (the `--json` convention: `JSON.stringify(x, null, 2)`).
- `src/integration/repos.ts`: `git` `:39`, `currentBranch` `:50`, `listRepos` `:89` (finds
  `packages-local/*` with a `.git` file too: worktrees count), `integrationOf` `:163`.
- `src/commands/release.ts`: `readDeps` `:159-174` (only `dependencies`, `devDependencies`,
  `peerDependencies`), `dependencyOrder` `:182-205`, used `:330`.
- `src/commands/worktree-node-modules.ts` (link farm, `linkNodeModules` `:242`) — not used by
  `checkout`; `src/localize/shared-install.ts:32` `sharedInstall`, `localize.ts:641-652`
  `refuseSharedInstall`.
- Localize: `src/localize/localize.ts` `localize` `:119`, `runLocalize` `:131-188`,
  `installAndBuild` `:194-238`, `prepareClone` `:254-333` (`git clone -- <repo> <dir>` `:300`, no
  branch, the URL as given lands in `.git/config`), `currentBranch` `:668`, `INSTALL_ARGS` `:76`;
  `src/localize/resolve.ts` `resolvePackage` `:55` (`npm view … repository` `:82`),
  `normalizeGitUrl` `:157`, `checkoutNameFor` `:191`; `src/localize/run.ts:47`
  (`env: opts.env ?? process.env`: env passes through, and `RunOptions.env` `:21` is the seam);
  `src/localize/app-root.ts` (`findWorkspaceRoot` `:60`); `src/localize/app-setup.ts:32-47`
  (the `postinstall`/`dependencies` lock-at-rest scripts), `hooks/lock-at-rest.cjs`;
  `src/localize/git-hooks.ts:125` (`installGitHooks`); `src/localize/errors.ts` (exit codes
  1/2/4/5/6/7).
- `src/installed-packages.ts:62-84` (`LinkedKind`, `LINKED_KINDS`, `linkedKind`): the list reader
  goes next to it.
- No CLI code fetches or pushes today except `create-app`'s first push (`src/cli-methods.ts:2860`).

CN (`/Users/rene/web/create_now`), read-only for CO:
- `src/backend/provisioners/CheckoutProvisioner.ts:98-139` (`cloneBranch`: `git clone --branch
  --single-branch`, token strip `:123-131`, `npm install` `:135-137`), `src/utils/projectsRoot.ts:19`
  (`CN_PROJECTS_ROOT`), `:53` (`branchClonePath`: CN passes it as `--dir` in BC).
- `src/backend/provisioners/GitHubProvisioner.ts:128-149` (`buildRepoProtectionPayload`:
  `enforce_admins: true`, pull-request reviews required — Pitfalls).

Tests: `tests/unit/integration/{branch,worktree,repos,releasePlan}.test.ts` (real throwaway repos
under `os.tmpdir()`: `initRepo`/`makeApp` in `worktree.test.ts:33,56`),
`tests/unit/localize/{real-localize,commands,resolve,git-hooks}.test.ts`, `helpers.ts`;
`jest.config.cjs` roots `tests/unit`.

### Pitfalls

- **Protected default branches refuse the push.** CN's app repos are protected with
  `enforce_admins: true` and required pull-request reviews (`GitHubProvisioner.ts:128-149`), so
  `git push origin HEAD:main` from `branch merge` is refused (GH006) even for the App. K-checkout's
  "fetch, merge, push" into the default branch cannot work on them as written; `--mode update`
  (push the branch, land by PR) is the proposal. Stop and report to the master before choosing.
- **One branch, one worktree.** A fallen-back package must be detached; two app checkouts on the
  same branch are refused (`git worktree add` would fail late otherwise).
- **Bare clones have no remote-tracking refs** until the fetch refspec is set; without it fetch
  updates nothing and every "exists on origin" check lies.
- **The token leaks four ways**: a URL in `.git/config` (`localize` today: `localize.ts:300`), a
  keychain credential helper storing what askpass supplied, argv (`-c http.extraHeader=…` shows in
  `ps`), and error text; and npm lifecycle scripts reading the env. Each has a test.
- `dependencyOrder` ignores `linked.unpublishedPackages`; without the new edges the asset package
  may merge before the ontology package.
- `listRepos` names repos by directory; `checkoutNameFor` (`resolve.ts:191`) decides the
  directory, so `fork`'s package matching must accept the plain npm name (`acme-ont`) too.
- Hooks: git runs hooks from the base clone's `hooks/` (or `core.hooksPath`) for all its
  worktrees; the localize hooks expect an app root — test them in an app worktree.
- `npm install` in an app worktree with no committed lockfile entry for the packages is expected
  (K-unpublished: `npm install`, never `npm ci`, while the list is non-empty).
- Do not reuse `worktree add`'s agent naming or integration-branch requirement; `checkout` needs
  neither.
- Build with `npx linked build`; after landing, the main checkout runs `npm run build` in the cli
  before anything else (057 Rules).

### Architecture and docs

- CLI `README.md` §Integration branches and worktrees (`:444`) and the localize paragraph
  (`:409-417`): `checkout`, `branch fork`/`merge`, `worktree remove --branch`, `localize --listed`.
- `docs/integration-branches-and-worktrees.md`: §`linked branch` (`:99`) gains fork and merge,
  §`linked worktree remove` (`:194`) the `--branch` form, a new §`linked checkout` (projects root,
  layout, branch rule, JSON, credentials) and §Limitations (`:272`).
- `docs/localize.md`: §Commands (`:189`) `--listed`, §Docker and CI (`:439`) the env token,
  §What it never does (`:500`) "never writes a token", §Exit codes (`:511`).
- CN `docs/architecture/03-packages-and-governance.md` §Local development (`:727`, the
  `unpublishedPackages` paragraph `:780-797`, "*Not built yet (plan 057)*" goes) and
  `docs/how-to/develop-a-linked-package-locally.md`.
- semantu-agents (`/Users/rene/packages/semantu-agents`, currently on branch
  `master-agent-skill`: branch from its default branch, not from that one):
  `skills/public/workflow/SKILL.md`, `implementation/SKILL.md`, `wrapup/SKILL.md`,
  `release/SKILL.md`, `master/SKILL.md` (all name `worktree add/remove`, `localize` or `branch
  start`); changeset; PR.

### Tests

- **Unit (pure):** `unpublishedPackages(json)` (valid, absent, non-object, bad URL, userinfo
  stripped); the transitive resolver over an in-memory map (duplicate same repo, same name two
  repos → refusal, cycle, rename mismatch); the branch rule (exists, fallback, created from
  `--from`); `branchDir('feat/x')`; `dependencyOrder` with `unpublishedPackages` edges;
  `gitRemoteEnv` (no token → empty; token → askpass, prompt off, helper reset; nothing on argv);
  the askpass hook answering both prompts; error-text scrubbing; JSON shapes.
- **E2E (no network):** `tests/unit/checkout/checkout.e2e.test.ts` — under `os.tmpdir()`, bare
  "remote" repos for an app and two packages (`file://` URLs; the asset package lists the ontology
  package, the app lists both; only the asset repo has `change-1`), a fake token in
  `LINKED_GIT_TOKEN`, `--no-install` (one case runs a real `npm install` with a dependency-free
  app, like `real-localize.test.ts`): checkout → JSON with the fallback; re-run → `unchanged`;
  commit on a package remote → `updated`; `branch fork change-1 <ont>` → pushed; commits on both
  branches; `branch merge change-1 --into main` → ontology, assets, app in order, merge commits on
  the remotes; a conflicting case stops at the first repo; `worktree remove --branch change-1` →
  refused before the merge, removes after; no config holds the token. Askpass is not exercised
  over HTTP (no network, no server): the unit tests assert the env and the hook directly.
- **Quick gate (1–2 min):**
  `npx jest --config jest.config.cjs tests/unit/checkout tests/unit/integration/branch.test.ts tests/unit/integration/worktree.test.ts tests/unit/integration/releasePlan.test.ts tests/unit/localize/commands.test.ts tests/unit/localize/resolve.test.ts tests/unit/linkedKind.test.ts`.
- **Full gate:** cli `npm run test:unit`, `npm run test:template`, `npx linked build`; CN (only
  the docs change there) `npm run typecheck:gate`. No CN regular set unless the agent touches CN
  code (it should not).

### Size and phases

Large, 4 phases, one commit each:
1. List reader, transitive resolver, branch rule, `dependencyOrder` edges, credentials seam
   (`gitRemoteEnv`, askpass hook, URL stripping, error scrubbing), `localize --listed` and
   `prepareClone` on the seam; unit tests.
2. `linked checkout` (base clones, worktrees, install, idempotency, JSON); the e2e checkout cases.
3. `branch fork`, `branch merge` (order, `--no-ff`, conflict stop, the mode question settled with
   the master), `worktree remove --branch`; e2e cases.
4. Docs, K-checkout updated in 002 and CN 057/180, changeset, semantu-agents PR, review fixes.

## Progress

- [x] LK — cli report 032, server report 020
- [x] RK — cli report 033
- [x] CO — cli report 034
