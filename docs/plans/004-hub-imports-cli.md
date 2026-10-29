---
summary: >
  Sub-plan of Create Now master plan 282 (shapes and packages per hub) for `@_linked/cli`:
  CL — backlog 013 part one (a machine-wide port lock under `~/.linked` with an async variant,
  `worktree relink --all`, `branch list`, `branch add-package`); CI — the component index file
  `linked build` emits next to `shapes.ttl` (with `@_linked/react`); BK — the `branch` key of an
  `unpublishedPackages` entry. Lands on the master `hub-imports`.
status: Plan
---

# 004 — Hub imports: CLI steps

## Master plan

[CN plan 282](../../../../docs/plans/282-shapes-and-packages-per-hub.md) —
`/Users/rene/web/wt/hub-imports/docs/plans/282-shapes-and-packages-per-hub.md` (decisions,
rules for every step, status table, numbers, starter prompt). Steps land on the master branch
`hub-imports` in this worktree (`/Users/rene/web/wt/hub-imports/packages-local/_linked-cli`) with
`git merge --ff-only hub-imports--<agent>`; never on `dev` or `main` directly.

## Contracts

K7 is copied verbatim from plan 282; K8 is detailed here (282 still lists it as open until the
master copies it back); the rest are there. A step that changes one updates
it here and in 282 in the same landing.

- **K7 `package.json` keys** (providers BK in `_linked-cli` and VD; consumers CN): an
  `unpublishedPackages` entry `{name, repo, branch?}` (D17, G8); `linked.defaultOntology: "<npm
  name>"` (D23).
  **Added by BK (detail; verbatim in CN 283 §Contracts K7):** `branch` is a valid git branch name
  other than `main` (the parser refuses anything else, exit 6 naming the entry); only the app's
  own list counts, a key in a package's (transitive) list is ignored with a warning; `linked
  checkout` reads the keys as pins (CN passes `--pins-only` and no `--pin`; an explicit `--pin`
  wins; `CheckoutPackage.pinFrom: 'key' | 'flag'`); `linked branch merge` lands the keyed package
  branches first (update mode refuses one not yet in `<into>`) and strips every key from the
  app's `package.json` (push mode: in the merge commit; update mode: one commit on the branch),
  so `main` lists no key (`MergeResult.strippedKeys`).
- **K8 Component index file** (provider CI: the generator in `@_linked/react`, the build step in
  `_linked-cli`, the terms in `@_linked/core`'s ontology; consumer CX). Settled at wave 2 (was
  *open*); copied verbatim into react plan 001 and, once the master accepts it, into 282.
  - **Enumeration.** A package offers components through `src/components/index.ts`
    (`lib/esm/components/index.js`): its named exports. Every export that is a linked component
    (made by `linkedComponent`/`linkedSetComponent`: carries `.query` and `.shape`) is indexed;
    other exports are ignored. No `components/index`, no file. A component exported under several
    names is one entry, named by the code-point-smallest of them.
  - **File.** `lib/esm/data/components.ttl`, written by the build step `Writing components.ttl`
    (right after `Writing shapes.ttl`) in a child `node` that imports `lib/esm/package.js` (when
    present), `lib/esm/shapes/index.js` (when present) and `lib/esm/components/index.js`, with
    asset hooks, then calls `componentIndexTurtle(packageName, componentsModule)` from
    `@_linked/react/utils/componentIndex` of the `@_linked/react` the package resolves.
    `packageName` is the name in `linkedPackage('<name>')` (else `package.json`'s), as for
    `shapes.ttl`. No linked component, no file; a file from an earlier build is removed whenever
    none is written. A react without `utils/componentIndex`: skipped with a warning. A module that
    throws on import fails the build. `--skip-shape-check` skips this step too.
  - **Vocabulary** (`https://linked.cm/ont/core/`, prefix `core:`, added to core's ontology module
    and `core.ttl`): classes `core:Component`, `core:SetComponent` (`rdfs:subClassOf
    core:Component`), `core:ComponentsGraph` (the graph kind CX registers, next to
    `core:ShapesGraph`); properties `core:definesComponent` (package → component),
    `core:exportName` (`xsd:string`), `core:startShape` and `core:queryShape` (→ a `sh:NodeShape`
    IRI), `core:query` (an `rdf:JSON` literal). `rdf:JSON` is added to core's `rdf` ontology module.
  - **IRIs.** A component: `{package IRI}/component/{encodeURIComponent(exportName)}`, where the
    package IRI is core's `getPackageUri(packageName)` (the root `shapes.ttl`'s shape IRIs hang
    off). CX stores the file's triples unchanged in `{package record IRI}/graph/components/{enc(key)}`
    (K1, D24); the component IRIs stay the package's.
  - **Per component.** `<package> core:definesComponent <component>`; `<component> a
    core:Component` (and `core:SetComponent` for a `linkedSetComponent`); `core:exportName`;
    `core:startShape` = the NodeShape IRI of the component's `.shape`; `core:queryShape` = the
    wire format's `shape`; `core:query` = `QueryBuilder.toJSON()` of the component's query (a set
    component's one-key `{prop: query}` wrapper unwrapped) as canonical JSON (object keys sorted
    recursively, arrays in order, no whitespace), typed `rdf:JSON`. Today start shape and query
    shape are the same IRI (react derives `.shape` from the query); D5 keeps them apart. A
    component whose query throws in `toJSON` is left out, with a build warning naming it.
  - **Queries bound at definition time** are recorded as `toJSON` writes them in the clean child,
    where no query context is set: `.for(getQueryContext('x'))` → `"subject":{"@ctx":"x"}`,
    `.for('<iri>')` → `"subject":"<iri>"`, `.for(null)` → `"nullSubject":true`. A query with a
    `subject` or `nullSubject` is bound: the builder gives it no `of`. `QueryBuilder.fromJSON`
    reads all three back.
  - **Determinism and hash.** One fixed prefix block (`core`, `rdf`, `xsd`), subjects sorted
    (package first, then components by IRI), `a` first and the other predicates sorted, one
    statement per line, no blank nodes; the same build gives the same bytes. The file carries no
    hash: CX hashes its bytes (SHA-256 hex, `core:contentHash` on the graph's registry record) and
    replaces the whole graph when the hash changes (D15).

  Example (`my-app`, one component of each kind; JSON shortened):
  ```turtle
  @prefix core: <https://linked.cm/ont/core/> .
  @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

  <https://linked.cm/pkg/my-app> core:definesComponent <https://linked.cm/pkg/my-app/component/PersonList> , <https://linked.cm/pkg/my-app/component/PersonPreview> .
  <https://linked.cm/pkg/my-app/component/PersonList> a core:Component , core:SetComponent ; core:exportName "PersonList" ; core:query "{\"fields\":[…],\"shape\":\"https://linked.cm/shape/schema/Person\",\"v\":1}"^^rdf:JSON ; core:queryShape <https://linked.cm/shape/schema/Person> ; core:startShape <https://linked.cm/shape/schema/Person> .
  <https://linked.cm/pkg/my-app/component/PersonPreview> a core:Component ; core:exportName "PersonPreview" ; core:query "{…}"^^rdf:JSON ; core:queryShape <https://linked.cm/shape/schema/Person> ; core:startShape <https://linked.cm/shape/schema/Person> .
  ```

Note on K7: on disk the list stays keyed by npm name, as `unpublishedPackages()` in
`src/installed-packages.ts` reads it today: `"linked": {"unpublishedPackages": {"<npm name>":
{"repo": "<url>", "branch": "<branch>"}}}`. `{name, repo, branch?}` is the parsed entry
(`UnpublishedPackage`).

### KC — CLI surface of step CL (provider CL; consumers the master and every later step)

- **Port lock.** `linked branch start <m> --worktree …` chooses and records its preview port
  holding one machine-wide lock, `<LINKED_HOME>/locks/master-ports/linked.lock`
  (`LINKED_HOME` defaults to `~/.linked`; the env override is for tests). Same holder format,
  wait (120 s), stale take-over and refusal (exit 6) as the repo lock. Inside the lock the free
  port is the first `45k0` slot that neither this app's masters (git config, as today) nor the
  machine registry `<LINKED_HOME>/master-ports.json` holds. The registry maps
  `"<port>": {"app": "<main checkout>", "master": "<m>", "dir": "<master worktree>"}`; an entry
  whose `dir` no longer exists is dropped when read. `branch start --worktree` adds its entry
  before releasing the lock; `worktree remove <m>` (`forgetMaster`) removes it. `--port` is
  refused when the registry or this app's masters hold it, naming the holder:
  `Port 4520 is master hub-imports's (/Users/rene/web/wt/hub-imports). Pick another, or leave --port out.`
  The app's git config stays the record of its own masters; the registry only answers "is this
  port taken on this machine".
- **`src/integration/repo-lock.ts` API** (additions; `withRepoLock`, `withCheckoutLock`
  unchanged):
  - `withRepoLockAsync<T>(gitDir, what, fn: () => Promise<T>, options?): Promise<T>` — the same
    lock file and holder; waits with timers, not `Atomics.wait`; releases after `fn`'s promise
    settles.
  - `linkedHome(): string` — `process.env.LINKED_HOME ?? path.join(os.homedir(), '.linked')`.
  - `withMachineLockAsync<T>(name, what, fn, options?)` — `withRepoLockAsync` on
    `<linkedHome()>/locks/<name>` (directory made on demand).
- **`linked worktree relink --all [--json]`.** Relinks every worktree of the app: each master's
  worktree, then that master's steps, then the other agent worktrees (`worktree list --all`
  minus the main checkout). Run anywhere in the app. Refused together with an agent name,
  `--dir` or `--from`. A worktree whose `node_modules` is an install of its own is left as it is
  (code 0, one line saying so). Text output: per worktree its `relink` lines under a heading
  `<dir>:`; last line `Relinked <n> worktrees` or `Relinked <n> of <t>; failed: <dir>, …`. Exit
  0 when every one relinked, 1 otherwise (the rest still run). JSON:
  `{code, worktrees: [{dir, kind: 'master'|'step'|'agent', master?, code, messages}]}`.
- **`linked branch list [--json]`.** The app's integration branches and masters in one view,
  from `listMasters`, `worktreeList` and the `branch.<b>.linked-target` records of the app repo
  and every `packages-local/` checkout. Text:
  ```
  BRANCH        KIND         TARGET  REPOS                 WORKTREE                        PORT  DATASET  STEPS
  hub-imports   master       dev     app, _linked-cli, …   /Users/rene/web/wt/hub-imports  4520  -        2
  some-branch   integration  dev     app, _linked-core     (checkouts)                     -     -        -
  Other masters on this machine: 4510 plan-x (/Users/rene/web/other-app)
  ```
  A text row names at most five repos (`app, _linked-a, _linked-b, _linked-c, … (+n)`); an app
  with no records prints `No integration branches or masters.`
  JSON: `{branches: [{name, kind, target, repos: [{rel, target, worktree}], dir, port, dataset,
  steps: [<agent>]}], otherPorts: [{port, app, master, dir}]}`. Exit 0 (an empty list too).
- **`linked branch add-package <m> <packages...> [--target <branch>] [--json]`.** Adds
  `packages-local/` checkouts (`@_linked/core`, `core` or `_linked-core`) to running master
  `<m>`. Run anywhere in the app. Per package: a worktree `<m's dir>/packages-local/<dir>` on a
  new branch `<m>` from `--target` (default: that checkout's current branch), its nested
  `node_modules` linked as `branch start --worktree` does, `branch.<m>.linked-target` and
  `branch.<m>.linked-worktree` recorded in that repo; then `worktree relink` of the master and of
  each of its steps. Checks everything before making anything; refused (exit 1, nothing made)
  when `<m>` is not a master, a package is unknown or already in `<m>`, a checkout is detached
  without `--target`, the target does not exist, the repo already has a branch `<m>`, or a step
  has a worktree of it (a branch `<m>--*`). A failure halfway undoes what this run made; a relink
  that fails afterwards keeps the worktrees and exits 1 (rerun `worktree relink --all`). Output: one line per worktree made and per relink,
  then `Master <m> now has: <dirs>` and `Build each added package there: npx linked build`. JSON:
  `{code, added: [{rel, dir, target}], relinked: [<dir>], messages}`.

## Steps

### CL — Master worktrees, part one (backlog 013)

**Depends on:** nothing (wave 1). Runs before the others need the CLI; until it lands the master
runs the CLI from `/Users/rene/web/create_now` (`npx linked`). **Once landed and built**, the
master runs its built copy: `node /Users/rene/web/wt/hub-imports/packages-local/_linked-cli/lib/esm/launch.js`
(this worktree has no `lib/` yet: `npx linked build` here first).

**Goal.** Two masters can start at the same time on one machine without taking the same preview
port; one command relinks every worktree after an `npm install`; one view lists branches and
masters; a framework package can join a running master by command.

**Scope.** Exactly KC above:

1. `linkedHome`, `withRepoLockAsync`, `withMachineLockAsync` in `src/integration/repo-lock.ts`.
2. The machine port registry (`src/integration/masters.ts`: `readPortRegistry`,
   `recordPort`, `releasePort`; `freeMasterPort(masters, registry)` takes both), used by
   `branchStartWorktree` (choose and record inside `withMachineLockAsync('master-ports', …)`)
   and by `forgetMaster`/`removeMaster` (release).
3. `worktree relink --all` (`worktreeRelinkAll` in `src/commands/worktree.ts`, `--all` in
   `src/cli.ts`).
4. `branch list` (`branchList`, `formatBranchList`, `runBranchList`; in `src/commands/master.ts`
   or `branch.ts`, whichever keeps imports acyclic).
5. `branch add-package` (`branchAddPackage`, `runBranchAddPackage` in `src/commands/master.ts`),
   with the per-package part of `createWorktreeSet` extracted into an exported
   `addPackageWorktree(spec, messages, run) → undo | null` that both use.
6. Docs: `docs/integration-branches-and-worktrees.md` §Masters (the three commands, the lock and
   registry), README command list; backlog 013 trimmed to what is left (`own-install`,
   `--package-only`, refusing a second copy, the two safety nets); changeset (minor).

Out of scope: `own-install`, `--package-only`, the safety nets of backlog 013, any CN change.

**Verify** (in the step's cli worktree):

- `npx jest --config jest.config.cjs tests/unit/integration tests/unit/checkout/repo-lock.test.ts`
  — the new and the existing master, worktree, branch and lock tests.
- `npm run test:unit` (`jest --config jest.config.cjs`) — the full unit suite. Without a built
  `lib/`, `shapeHierarchy` and `ontologyDataReachable` fail on untouched code too (report 040):
  build first, then run.
- `npx linked build` — clean.
- The built CLI end to end in a sandbox under the scratchpad, with `LINKED_HOME` pointing into it:
  two `branch start <m> --worktree` started in parallel from two sandbox apps (`&` and `wait`)
  get different ports; `branch list` (text and `--json`) in each; `branch add-package` on one
  master with a step present, then the step's farm shows the added package as an overlay;
  `worktree relink --all`; `worktree remove` of the step and the master frees the registry entry.
  Output quoted in the report.
- Not run: `npm run test:e2e` (Docker); CN's tests (no CN change).

**Done when:** the four commands behave as KC says; the tests below pass; full unit suite green
after the build; sandbox run quoted; docs, backlog 013 and the changeset in the landing; report
`docs/reports/041-master-worktrees-part-one.md` (two parts: `## PR`, `## Details`); this section
ticked in §Progress; landed by ff-only into `hub-imports` in
`/Users/rene/web/wt/hub-imports/packages-local/_linked-cli`; then the master builds it there.

**Files found in code:**

- `src/commands/master.ts` — `branchStartWorktree` (line 73): `listMasters` at 109, the port
  chosen at 114 (`freeMasterPort`), `createWorktreeSet` at 132, `linked-port` recorded at 157.
  The function is async throughout (`listMasters`, `setTarget` await), so the lock around
  choose-and-record must be the async variant.
- `src/integration/masters.ts` — `Master`, `MASTER_PORTS`, `masterOf`, `listMasters` (git config
  `branch.*.linked-worktree` of one app repo), `freeMasterPort`, `stepPorts`, `forgetMaster`.
- `src/integration/repo-lock.ts` — `acquire` (file `linked.lock`, `wx` create, stale take-over),
  `withRepoLock` (line 149, sync, re-entrant per process via `held`, `sleep` = `Atomics.wait`),
  `commonDirOf`, `withCheckoutLock`. Callers: `src/commands/checkout.ts`,
  `src/commands/branch-fork-merge.ts`.
- `src/commands/worktree.ts` — `createWorktreeSet` (163; app worktree, `.env` links, then the
  package loop 226-244, then the farm), `worktreeList` (710; hides the master it is run in),
  `everyWorktree` (700), `findAppWorktree`, `removeMaster` (1045), `worktreeRelink` (1160-1208,
  one dir), `runWorktreeRelink` (1219), `MasterWorktrees` (675).
- `src/commands/worktree-node-modules.ts` — `farmOverlays(dir, parent)` (266), `readFarmMarker`,
  `linkNodeModules`, `overlaysOf`.
- `src/commands/branch.ts` — `branchStatus` (158), `selectCheckouts` (245), `worktreesOf`,
  `refExists`, `localBranchExists`.
- `src/integration/repos.ts` — `getTarget`/`setTarget` (`branch.<b>.linked-target`), `listRepos`.
- `src/cli.ts` — `branch` (674: `status`, `start`, `land`, `fork`, `push`, `merge`) and
  `worktree` (778: `add`, `list`, `remove`, `relink` at 842).

**Pitfalls:**

- `withRepoLock` around an async `fn` releases before the promise settles (its `finally` runs at
  once): never wrap `branchStartWorktree`'s body in it; use `withRepoLockAsync`.
- The sync lock's `held` map makes a second acquisition in the same process re-entrant. The async
  variant must not inherit that: two overlapping async calls in one process would both "re-enter".
  Keep its own per-key queue (or no re-entry) and test two overlapping calls.
- A lock alone does not stop two different apps (two app repos, two git configs) from picking the
  same slot one after the other: the registry is what makes the choice machine-wide.
- Tests must never touch the real `~/.linked`: every test sets `LINKED_HOME` to a temp dir.
- `createWorktreeSet` always adds the app worktree first, so `add-package` cannot call it as it
  is; extract the package loop, keeping `createWorktreeSet`'s messages and undo order unchanged.
- Steps do not farm into the master's `node_modules`: their marker's `installRoot` is the main
  install and `parent` names the master, whose `overlaysOf` is read from its directory. A step
  therefore sees a package added to the master on its next relink, whatever the order; `--all`
  still relinks masters first so the output reads top-down.
- `worktreeList` run inside a master's worktree omits that master; `relink --all` and
  `branch list` resolve the main checkout first (`mainCheckoutOf`) and list from there.
- `add-package` while a step holds a worktree of the same package on `<m>--<agent>`: impossible
  today (a step can `--with` only the master's packages), but check and refuse rather than assume.
- The master's own CLI must not change under it mid-wave: land CL, then `npx linked build` in the
  master's cli worktree, then the master switches to the built bin.

**Tests:**

- New, `tests/unit/checkout/repo-lock.test.ts`: `withRepoLockAsync` holds across an awaited
  `fn` (a second waiter gets it only after the promise settles); two overlapping calls in one
  process serialize; a stale holder is taken over; a timeout refuses with exit 6 naming the
  holder; `withMachineLockAsync` creates `<LINKED_HOME>/locks/<name>`.
- New, `tests/unit/integration/master.test.ts`:
  - two `branchStartWorktree` calls started together (`Promise.all`) in two sandbox apps sharing
    one `LINKED_HOME` get different ports, and both are in the registry;
  - `--port` held by another app's master (registry only) is refused, nothing made;
  - a registry entry whose `dir` is gone is ignored and dropped;
  - removing a master releases its port;
  - `branch list`: a master and a plain integration branch, text and JSON, `otherPorts`;
  - `branch add-package`: worktree on `<m>`, both records, the master's and the step's farms
    gain the overlay; refusals (not a master, already present, unknown package, branch `<m>`
    exists) change nothing; a failing `git worktree add` undoes the earlier packages.
- New, `tests/unit/integration/worktree.test.ts`: `relink --all` relinks a plain agent worktree,
  a master and its step; one broken worktree fails with exit 1 while the others relink; `--all`
  with an agent name is refused.
- Existing, must stay green: `tests/unit/integration/master.test.ts`,
  `tests/unit/integration/worktree.test.ts`, `tests/unit/integration/branch.test.ts`,
  `tests/unit/integration/repos.test.ts`, `tests/unit/checkout/repo-lock.test.ts`,
  `tests/unit/checkout/land.e2e.test.ts`, `tests/unit/worktreeNodeModules.test.ts`,
  `tests/unit/doctorResolve.test.ts`.

**Size and phases:** small–medium; no plan doc of its own (282 §Numbers), report cli 041.

1. Locks and the registry (`repo-lock.ts`, `masters.ts`, `branchStartWorktree`,
   `forgetMaster`/`removeMaster`) with their tests.
2. `worktree relink --all` and `branch list` with their tests.
3. `addPackageWorktree` extraction and `branch add-package` with its tests.
4. Docs, backlog 013, changeset, `npx linked build`, full unit suite, sandbox run, report.

One commit per phase; sequential (one agent).

### CI — Component index build (K8)

**Depends on:** nothing (wave 2). Repos: `@_linked/core` (vocabulary only), `@_linked/react`
(the generator), `_linked-cli` (the build step). Order inside the step: core, then react, then
cli; each built in its master worktree before the next uses it. The react half is
[react plan 001](../../../_linked-react/docs/plans/001-hub-imports-react.md) §CI; this section is
the whole step. Consumer: CN step CX (reads the file on import and publish).

**Goal.** `linked build` of a package that has `src/components/index.ts` writes
`lib/esm/data/components.ttl` (K8): per exported linked component its name, start shape, query
wire format and query shape, as deterministic Turtle CN can store and hash-replace without
reading any component code.

**Scope.** Exactly K8:

1. **Core vocabulary.** `src/ontologies/linked-core.ts`: `Component`, `SetComponent`,
   `ComponentsGraph`, `definesComponent`, `exportName`, `startShape`, `queryShape`, `query` in
   `coreOntology`; `src/data/core.ttl`: their definitions (labels, comments, domains/ranges,
   `core:SetComponent rdfs:subClassOf core:Component`); `src/ontologies/rdf.ts`: `JSON`
   (`rdf:JSON`). Changeset (minor).
2. **React generator.** `src/utils/componentIndex.ts`: `componentIndexEntries(packageName,
   moduleExports)` → `ComponentIndexEntry[]` (`{iri, exportName, set, startShape, queryShape,
   query}`, sorted by IRI, one per component object) and `componentIndexTurtle(packageName,
   moduleExports)` → `string | undefined` (K8's fixed form; `undefined` when there is no linked
   component), plus the warnings for queries that do not serialize (`{turtle, warnings}` or a
   `warnings` out-param; one shape, chosen by the step). `linkedSetComponent` marks its result
   (`setComponent: true` on the wrapped component; the index reads the marker, not the shape of
   `.query`). `LinkedSetComponent.query`'s type corrected to what it holds at runtime (the
   QueryBuilder or the one-key wrapper). Peer `@_linked/core` range raised to the release with
   the terms. Changeset (minor).
3. **CLI build step.** `src/utils/componentsTurtle.ts` (mirrors `shapesTurtle.ts`):
   `COMPONENTS_TURTLE_PATH`, `collectComponentsTurtleInputs`, `generateComponentsTurtle`,
   `writeComponentsTurtleStep`; the step `Writing components.ttl` in `planBuildSteps`
   (`src/cli-methods.ts`) right after `Writing shapes.ttl`, skipped by `--skip-shape-check`.
   Warnings from the generator are printed as the step's warning. Changeset (minor).
4. **Docs.** CLI: the build steps list in `README.md` and `docs/` where `shapes.ttl` is described
   gains `components.ttl` and the `components/index` convention. React: `README.md` §components
   (export your components from `src/components/index.ts` so the builder can index them).
   Core: none beyond `core.ttl`'s comments.

Out of scope: CN reading the file (CX); props schemas, capabilities and other metadata (G5:
later); making `linkedPackage(name).linkedComponent` register under `name`; a check that every
component module is in `components/index` (a later `Checking components/index`, backlog item in
cli, homed by the step).

**Verify** (in the step's worktrees; `npx linked build` from each package):

- Core: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
  src/tests/core-ontology.test.ts` and `npm test` (full suite + typecheck); `npx linked build` clean.
- React: `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs
  component-index` (new) and `npm test` (full suite); `npx linked build` clean.
- CLI: `npx jest --config jest.config.cjs tests/unit/componentsTurtle.test.ts
  tests/unit/shapesTurtle.test.ts`; `npx linked build`, then `npm run test:unit` (a built `lib/`
  first, report 040).
- End to end with the built CLI (`node <step cli worktree>/lib/esm/launch.js build`), in a sandbox
  package under the scratchpad whose `node_modules` links the step's built core and react and
  CN's `react`: `package.ts`, one shape, `src/components/index.ts` exporting a `linkedComponent`
  (with a `.module.css` and an `.svg` import), a `linkedSetComponent` bound with
  `.for(getQueryContext('user'))`, the same component under a second name and a plain function.
  Quote `lib/esm/data/components.ttl`; build again and `cmp` the two files (identical); in a
  `node` one-liner, `QueryBuilder.fromJSON(JSON.parse(<each core:query literal>)).toJSON()`
  equals the literal's JSON; delete `components/index.ts`, build, the file is gone.
- Not run: CN's tests (no CN change); `npm run test:e2e` of the cli (Docker).

**Done when:** K8 holds as written; the tests below pass in all three repos; the sandbox run
quoted; changesets in core, react and cli; report cli `docs/reports/042-component-index.md` (two
parts, `## PR` and `## Details`, the whole step) and react `docs/reports/004-component-index.md`
(the react half, linking 042); core's change named in 042 with its commit; plan doc cli
`docs/plans/005-component-index.md` created at the start and deleted before landing; this
section and react plan 001 ticked; landed ff-only into `hub-imports` in each master package
worktree (core, react, cli in that order), each built there.

**Files found in code:**

- `src/cli-methods.ts` — `planBuildSteps` (3202); steps `Copying files to lib folder` (3236:
  copies only `**/*.{json,d.ts,css,scss,ttl}`), `Writing shapes.ttl` (3384,
  `writeShapesTurtleStep(packagePath, {skip: options.skipShapeCheck})`), `Checking sideEffects`
  after it; `skipShapeCheck` option (3159).
- `src/utils/shapesTurtle.ts` — the precedent: `collectShapesTurtleInputs` (core resolved with
  `resolvePackageDir` from `shapeHierarchy.ts`, skip reasons), `runtimePackageName` (reads
  `linkedPackage('<name>')` from `lib/esm/package.js`), the `GENERATE` child script (`-e`, marker
  line `__LINKED_SHAPES_TURTLE__`, env-passed inputs), `writeShapesTurtleStep` (remove a stale
  file whenever none is written).
- `src/utils/shapeReferences.ts` — `ASSET_HOOK` (111): a `load` hook only, turning
  `.css/.svg/.png/…` into a proxy module; `findShapeModules`.
- `src/utils/shapesIndex.ts` — the `shapes/index` convention and its check (precedent for a
  later `Checking components/index`).
- `src/loaders/register.ts`, `css-loader.mts`, `ts-loader.mts` — the CLI's own hooks for running
  an app from source (TS, CSS modules with real scoped names). Not needed here: the child loads
  compiled `lib/esm`, and class names do not matter to the index.
- `tests/unit/shapesTurtle.test.ts`, `tests/fixtureNodeModules.ts` — fixture packages written as
  tsc emits them, `node_modules/@_linked/core` linked from the repo.
- `@_linked/react` `src/utils/LinkedComponent.ts` — `createLinkedComponentFn` (253): `processQuery`
  derives `shapeClass` from `query.toJSON().shape` (585-613); `.original`, `.query`, `.shape`
  set at 403-405; `createLinkedSetComponentFn`: `.query` is the un-normalized input (the one-key
  wrapper), 561-563; `options.name` names only the live-query template, not the component.
- `@_linked/react` `src/package.ts` — registry `shapeToComponents` (shape → components, not keyed
  by package); `linkedComponent` is built once with `@_linked/react`'s own
  `registerPackageExport`, so `linkedPackage('<name>').linkedComponent` registers under
  `@_linked/react`, and components that import `linkedComponent` from `@_linked/react` (CN's
  `my-app` does) carry no package at all. Hence the `components/index` export convention.
- `@_linked/core` `src/queries/QueryBuilder.ts` — `toJSON` (685; `subject` as `{"@ctx"}` for a
  pending context, `nullSubject`, wire `v`), `fromJSON` (760); `src/queries/QueryContext.ts`
  `getQueryContext` (107: a `PendingQueryContext` while unset); `src/shapes/SHACL.ts`
  `getPackageUri` (98); `src/shapes/syncShapeGraphs.ts` `shapeGraphHash` (52, CX's precedent);
  `src/shapes/shapesToTurtle.ts` (the fixed-form rules K8 copies); `src/ontologies/linked-core.ts`,
  `src/ontologies/rdf.ts`, `src/data/core.ttl`.

**Pitfalls:**

- `ASSET_HOOK` is a `load` hook; a component importing an asset the build does not copy
  (`.svg`, `.png`, fonts: not in the copy glob) fails at **resolve** before `load` runs. The
  child needs a `resolve` hook for asset extensions too (short-circuit to a synthetic URL when the
  file is missing). Keep `ASSET_HOOK` itself unchanged for the shape checks, or extend it and
  rerun their tests.
- Compiled `.tsx` imports `react/jsx-runtime`: `react` must resolve from the package (it does in
  an app clone and a localized package; a fixture must link it). React's peer is not the CLI's
  dependency: never add `react` to the CLI's `dependencies`.
- Load order matters: `package.js` (sets the package's publish root, so `getPackageUri` and shape
  IRIs are the package's), then `shapes/index.js`, then `components/index.js`. Calling
  `getPackageUri` before `package.js` ran gives the default root.
- Two copies of core or react in the child (the package's and the CLI's): import the generator
  from the react **the package resolves** (as `shapesTurtle.ts` does for core); detect linked
  components by duck type/brand (`isLinkedInstance`), never `instanceof`.
- A query context set at module load (`setQueryContext` at top level of some imported module)
  serializes as a resolved IRI, not `{"@ctx"}`. Nothing in the framework does this; note it in
  the README, do not work around it.
- `toJSON` runs callbacks (`select`, `where`, `sortBy`) through proxies; a query that throws
  there must cost one component (warning), not the build.
- Canonical JSON: `JSON.stringify` keeps insertion order, which depends on code paths; sort keys
  recursively before writing. Escape the literal for Turtle (`\\`, `\"`, `\n`, `\r`, `\t`).
- A package with an ontology already ships `lib/esm/data/*.ttl` (copied from `src/data/`); a
  `src/data/components.ttl` would be overwritten. Same rule as `shapes.ttl`: the name is
  reserved (say so in the README).
- `--skip-shape-check` removes `components.ttl` too (its shapes are unchecked), so a package
  never ships an index whose shapes may be wrong.
- Land core first and build it in the master: react's generator imports the new terms, and the
  CLI's fixtures load the built react.

**Architecture.** Same split as `shapes.ttl`: the framework package that owns the concept
generates (core → shapes, react → components), the CLI only loads the built package in a child
and writes the file. The CLI never parses component code and never imports react itself. The
index is opt-in per package by `components/index` (G5), so no existing build changes. CN (CX)
treats the file as opaque bytes plus a hash: it copies the triples into its own graph and never
runs the generator, so the format is fixed by K8 and versioned by the react release that writes
it.

**Tests:**

- New, cli `tests/unit/componentsTurtle.test.ts` (fixtures as tsc emits them; a stub
  `@_linked/react/utils/componentIndex` in the fixture's `node_modules` for the mechanics, so the
  CLI needs no react dev dependency): no `components/index` → no file and a stale one removed;
  modules imported in order (`package.js`, `shapes/index.js`, `components/index.js`), the
  package name from `linkedPackage`; an `.svg`/`.css` import resolves; a throwing module fails the
  step naming it; a react without the module → skip with a warning; generator warnings surface;
  `--skip-shape-check` removes the file; `planBuildSteps` has `Writing components.ttl` right after
  `Writing shapes.ttl`.
- New, react `src/tests/component-index.test.tsx`: single and set components (types, IRIs,
  `exportName`, start and query shape, canonical JSON); an alias exported twice → one entry; a
  plain function and a non-component export ignored; `.for(getQueryContext('x'))`, `.for(iri)`,
  `.for(null)` serialize as K8 says and `QueryBuilder.fromJSON` reads each back; a query whose
  `toJSON` throws → left out with a warning; two calls give identical bytes, independent of export
  order; no component → `undefined`; IRIs encode an export name with non-ASCII characters.
- New, core: `core-ontology.test.ts` gains the new terms (module ↔ `core.ttl` agree).
- Existing, must stay green: cli `tests/unit/shapesTurtle.test.ts`, `shapeReferences.test.ts`,
  `shapesIndex.test.ts`, `shapeHierarchy.test.ts`, `cssLoaderMode.test.ts`; react
  `react-component-behavior.test.tsx`, `classnames-and-query-context.test.tsx`,
  `across-copies.test.tsx`, `native-barrel.test.tsx`, `reactivity.test.tsx`; core
  `core-ontology.test.ts`, `shacl-serialization-ontology.test.ts`, the QueryBuilder serialization
  tests.

**Size and phases:** medium; plan doc cli `005-component-index.md`; reports cli 042, react 004.

1. Core vocabulary + `rdf:JSON`, tests, changeset; land and build core in the master.
2. React `setComponent` marker, type fix, `utils/componentIndex.ts`, tests, README, changeset;
   land and build react.
3. CLI `componentsTurtle.ts`, the build step, tests, docs, changeset.
4. Sandbox end-to-end run, reports 042 and 004, plans ticked; land the CLI and build it.

One commit per phase; sequential (one agent).

### BK — The `branch` key (K7, D17, G8)

Sensitive (CN commits `branch` keys into app repos; checkout pins). One step, two repos, one
agent: this cli half lands first and is built in the master's cli worktree; the CN half is
[CN 283 §BK](../../../../docs/plans/283-shapes-and-packages-per-hub-cn.md). Detail found in the
code on cli `hub-imports` after CI.

**Depends on:** CL (landed). CN's half depends on CN step IX.

**Goal.** An app branch names the package branch it uses in its own `package.json`; checkout,
localize and merge follow it; merging leaves no key on the target.

**Scope.**

1. **Parser** (`src/installed-packages.ts`): `UnpublishedPackage` (:153-158) gains `branch?:
   string`. `unpublishedPackages(json, warn)` (:171-216) reads an entry's `branch`: absent → none;
   a non-empty string that is a valid branch name → kept; anything else (not a string, empty,
   `main`/`HEAD`, a name `git check-ref-format --branch` would refuse) → `LocalizeError(…,
   EXIT_REFUSED)` naming `linked.unpublishedPackages of <name>` and the entry. The parser stays
   pure: a new `isBranchName(name)` in `src/integration/branchName.ts` implements
   check-ref-format's rules (no `..`, `@{`, control chars, space, `~^:?*[\`, no leading `-`, no
   `/`-component starting with `.` or ending `.lock`, no trailing `/` or `.`); a unit test compares
   it with `git check-ref-format --branch` over a table. `src/commands/release.ts:170-175` reads
   the list raw and is unchanged.
2. **Walk** (`src/integration/unpublished.ts`, `walkUnpublished` :31-67): `ListedPackage` keeps
   `branch` only from the root list; an entry reached through a package's list drops its key with
   one warning (`<pkg>'s list names branch <b> for <name>; ignored, the app's list decides`); a
   name reached twice is a conflict on `repo` only (:46-51), never on `branch`.
3. **Checkout** (`src/commands/checkout.ts`): after the walk, the root list's keys become pins
   (`pinsFromKeys(listed)`), merged under the explicit ones: `{...keys, ...options.pins}` (an
   explicit `--pin` wins; the run says `pin <name>=<b> from --pin overrides the app's branch key
   <k>`). A key makes `pinsMode` (:730) true as a pin does today, so the rest of `targetOf`
   (:738-750) is unchanged: pin on origin → that branch (`readOnly` when it is not the run branch);
   pin missing on origin → today's message and `{branch: null}` (detached on the default). A key
   equal to the run branch is a pin on the run branch (writable). Validation of pins (:318-334)
   covers the keys. `CheckoutPackage.pin` (:126) is set for a key too, plus `pinFrom: 'key' |
   'flag'` (new, optional) in the JSON.
4. **Localize** (`src/localize/localize.ts`, `localizeListed` :243-293): an entry with `branch`
   clones on it (`prepareClone(…, {branch: entry.branch})`, the rest as today); without one, the
   app's current branch rule (:266, `checkOutBranch` :481-510) as today. A key naming a branch the
   repo lacks: the clone stays on its default branch with today's log line.
5. **Merge** (`src/commands/branch-fork-merge.ts`, `branchMerge` :530): reads the app's
   `package.json` at `origin/<branch>` (after the fetch, :584-613) for keys.
   - A key equal to `<branch>`: that package is merged in this run as today (its checkout is on
     `<branch>`).
   - A key naming another branch `<k>`: **push mode** merges `origin/<k>` into `<into>` of that
     package first (`mergePush` on the package's checkout dir, found by name through
     `listRepos`; it may be detached), in dependency order before the same-name packages; a
     package with no checkout here → refused (exit 6, nothing merged). **Update mode** (CN's) does
     not merge `<k>`: it refuses (exit 6, naming the package and `<k>`) unless `origin/<into>`
     already contains `origin/<k>` (`git merge-base --is-ancestor`); CN lands such branches first
     with its own PRs (CN 283 §BK item 6).
   - **Strip.** The app's merge removes every `branch` key from `package.json`: push mode amends
     the app's merge commit in its temporary worktree (`git commit --amend --no-edit` after the
     edit, before the push); update mode adds one commit `Use main of <pkgs>` on the branch after
     merging `origin/<into>` in and before the push. An app with no keys: nothing changes.
     `MergeResult` gains `strippedKeys: string[]` and `MergeRepo.via: 'key' | 'branch'`.
6. **Docs:** README :441-446, :492-493, :501-506; `docs/localize.md` :197, :237-266 (the on-disk
   example with `branch`, the branch sentence :256), :567; `docs/integration-branches-and-worktrees.md`
   :200-221 (merge lands keyed branches, strips keys), :483-545 (branch rule :519-525: key first;
   Pins :529-541: keys are pins, `--pin` wins; :540 Create Now passes `--pins-only` only), :565-572;
   `src/cli.ts` help :597, :789, :881, :896, :899; header comments `checkout.ts:1-26`,
   `localize.ts:234-240, :478`. Changeset (minor).

Out of scope: any CN change (CN 283 §BK); a command that sets a key (CN edits `package.json`
itself; a `linked use <pkg> --branch` is a later backlog item if wanted).

**Verify** (in the step's cli worktree; `npx linked build` first, report 040):

- `npx jest --config jest.config.cjs tests/unit/checkout/unpublished.test.ts
  tests/unit/localize/listed.test.ts tests/unit/checkout/pins.e2e.test.ts
  tests/unit/checkout/land.e2e.test.ts tests/unit/checkout/checkout.e2e.test.ts
  tests/unit/integration/branch.test.ts tests/unit/integration/branchName.test.ts`.
- `npm run test:unit` — the full unit suite, after the build.
- `npx linked build` — clean.
- End to end with the built CLI in a sandbox under the scratchpad (`makeRemotes()`-style `file://`
  remotes): an app branch `change-1` whose entry for `ont` has `"branch": "rene/topic"`;
  `linked checkout change-1 --pins-only --json` puts `ont` on `rene/topic` (`pin`, `pinFrom:
  "key"`); `--pin ont=main` overrides it; `localize --listed` clones `ont` on `rene/topic`;
  `branch merge change-1 --into main --mode push` lands `ont`'s `rene/topic` first, then the app,
  and `git show origin/main:package.json` has no `branch`. Output quoted in report 043.
- Not run: `npm run test:e2e` (Docker); CN's tests (CN half).

**Done when:** K7's `branch?` holds as in CN 283 §Contracts K7 (Added by BK); the tests below
pass; the sandbox run quoted; docs and changeset in the landing; report
`docs/reports/043-branch-key.md` (two parts); this section ticked; landed ff-only into
`hub-imports` in `/Users/rene/web/wt/hub-imports/packages-local/_linked-cli` and built there
before the CN half's tests.

**Files found in code:** `src/installed-packages.ts` (:153-216); `src/integration/unpublished.ts`
(:13, :31-67, :88-105); `src/commands/checkout.ts` (:104-106, :113-157, :244-254, :316-382,
:730-787, :869-990, :1141-1196); `src/localize/localize.ts` (:111-115, :243-293, :448, :481-510);
`src/commands/branch-fork-merge.ts` (:100, :504-530, :558-625, :665, :725, :825);
`src/localize/errors.ts` (:11-25); `src/cli.ts` (:597, :789, :881, :895-899);
`tests/unit/checkout/helpers.ts` (`makeRemote` :41, `commitOn` :60, `makeRemotes` :86, `setup`
:156).

**Pitfalls:**

- `unpublishedPackages()` is pure and called by `checkout`, `localize` and the walk: no git call
  inside it (hence `isBranchName`).
- A key is a pin: an app branch keyed to a colleague's branch gets that package read-only
  (detached at `origin/<k>`), as a `--pin` does today. CN's code-sync fork keys the same-name
  branch, which stays writable.
- Merge order: keyed other-name branches before the same-name packages, packages before the app
  (`dependencyOrder`), and stop at the first conflict as today: the strip runs only when every
  package merged.
- Update mode must never merge a keyed other-name branch itself (CN lands it through a PR with a
  release commit); refuse instead.
- The strip edits only the `branch` keys (keep key order and formatting: parse, delete, write
  with the file's indent and trailing newline).
- Never add `branch` keys to transitive lists in fixtures except to test that they are ignored.

**Tests:**

- `tests/unit/checkout/unpublished.test.ts`: parser keeps a valid `branch`; refuses `main`, `""`,
  `a..b`, `-x`, a number (exit 6, message names the entry); walk keeps the root's key, drops a
  transitive one with a warning, no conflict on differing transitive keys.
- New `tests/unit/integration/branchName.test.ts`: `isBranchName` agrees with `git
  check-ref-format --branch` over a table.
- `tests/unit/checkout/pins.e2e.test.ts`: a key places the package (pin, `pinFrom: 'key'`, read-only
  when not the run branch); `--pin` overrides a key; a key to a missing branch → message, detached
  on the default; a same-name key is writable.
- `tests/unit/localize/listed.test.ts`: `--listed` clones on the key's branch.
- `tests/unit/checkout/land.e2e.test.ts`: push mode lands a keyed other-name branch first and the
  merge commit has no key; update mode refuses an unmerged keyed branch and strips the keys once it
  is merged (`strippedKeys`); an app without keys unchanged.
- Existing, must stay green: `checkout.e2e.test.ts`, `repo-lock.test.ts`, `branch.test.ts`,
  `release` tests (`dependencyOrder`).

**Size and phases:** medium (with CN's half); CN plan doc 290 covers both; reports cli 043, CN
291.

1. Parser, `isBranchName`, walk, with tests.
2. Checkout keys as pins, localize, with tests.
3. Merge (push and update), strip, with tests.
4. Docs, changeset, build, full suite, sandbox run, report 043; land and build in the master.

## Progress

- [x] CL — machine-wide port lock and registry, `withRepoLockAsync`, `worktree relink --all`,
  `branch list`, `branch add-package` (report 041)
- [ ] CL landed in `hub-imports` and built in the master's cli worktree; master on the built bin
- [x] CI — component index build: core terms, react generator, `Writing components.ttl` (reports
  cli 042, react 004, core 085; follow-ups cli backlog 014, 015, react plan 001 §Release)
- [ ] BK — `branch` key, cli side (detailed at wave 3; report 043)
