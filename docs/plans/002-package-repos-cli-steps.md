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
  published package moves into `dependencies` with a range.
- **K-checkout** (provider CO; consumers BC, PC, deploy): `linked checkout <branch>` in a projects
  root: one base clone per repo, the app as a `git worktree` on `<branch>` (created from `--from`,
  default the default branch, when the remote lacks it), the packages of
  `linked.unpublishedPackages` (transitively) as worktrees in `packages-local/` on `<branch>` if
  the package repo has it, else on its default branch; one install; `--json` result listing the
  app dir and each package with its branch and whether it fell back. `linked branch fork <branch>
  <package>`: create the branch in that package checkout from its current head and push it.
  `linked branch merge <branch> --into <default>`: packages in dependency order, then the app;
  fetch, merge, push; stop at the first conflict. Credentials only through the environment
  (a short-lived token via `GIT_ASKPASS` / credential helper env); no token is ever written to
  `.git/config`. CO fixes flag names and the JSON shape and records them here when it lands.
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

**Depends on:** LK (RK landed first: CO rebases on it, both touch the CLI). **Repo:** cli (+ CN
docs, semantu-agents skills PR). **Plan doc:** cli `docs/plans/005-…`. **Report:** cli
`docs/reports/034-…`. **Test port:** 4345. **Size:** large. Sensitive (credentials): independent
review. *Plan-mode detail is added when its wave starts.*

**Goal.** K-unpublished and K-checkout: one command makes a branch checkout of an app and its
unpublished packages as git worktrees of base clones, with credentials only in the environment.

**Scope.** `linked.unpublishedPackages` read by `localize` (transitively, one install);
`linked checkout <branch>` (base clone per repo, app and package worktrees, fallback to the default
branch, `--from`, `--json`); `linked branch fork <branch> <package>`; `linked branch merge <branch>
--into <default>` (dependency order, then the app; stop at the first conflict); `worktree remove`
checks landed against the default branch; credentials via `GIT_ASKPASS` / credential-helper env,
never a token in `.git/config`; `--json` on the new commands. Docs: README,
`docs/integration-branches-and-worktrees.md`, `docs/localize.md`, CN docs (arch-03 §Local
development), the semantu-agents skills (`/Users/rene/packages/semantu-agents`, branch + PR).
CO fixes the flag names and JSON shape and records them in K-checkout here and in 057.

**Done when.** K-unpublished and K-checkout hold, with the flag names and JSON shape recorded; a
test makes a checkout of an app with two unpublished packages (one only on the default branch:
fallback reported), forks a package branch, merges both into the default branch; no
`.git/config` under the checkout contains a token; docs and skills PR done.

**Known files and pitfalls.**
- `worktree add` (`src/cli.ts:704-717`, `src/commands/worktree.ts:125-363`) always makes
  `<base>--<agent>`, refuses existing branches, no fetch/push, needs an integration branch: add
  `checkout` next to it, not instead of it. `worktree list --json` exists (`cli.ts:719-724`);
  `landed()` (`commands/worktree.ts:395-398`) checks against the base; `remove` `:575`.
- `localize` (`src/localize/localize.ts:119-333`, `src/localize/resolve.ts:55-104`): full clone,
  repo from `npm view` or one `--repo`, no branch, one install per run, may leave a token in
  `.git/config` — CN strips it today (`src/backend/provisioners/CheckoutProvisioner.ts:123-131`).
- Credentials can pass through the env: `src/localize/run.ts:47` (`env: opts.env ?? process.env`).
- Ordering: `dependencyOrder` (`src/commands/release.ts:182`).
- The localize postinstall restores the committed lockfile; a checkout made by `linked checkout`
  is an app's own install, not CN's workspace (different rule: say which in the docs).

## Progress

- [ ] LK
- [ ] RK
- [ ] CO
