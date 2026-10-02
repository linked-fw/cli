---
summary: create-package chooses between packages/ (the app's repo) and packages-local/ (its own repo, localize-compatible), with an `adopt` mode added to @_linked/localize.
status: Implementation
---

# 001 — create-package: packages/ or packages-local/

## Problem

`linked create-package` writes into `<cwd>/packages/<bare-name>`. In an app that now uses
`localize`, `packages/` holds only packages that live in the app's own repository. A package
with its own repository belongs in `packages-local/`, under localize's scope-flattened name
(`@_linked/foo` → `packages-local/_linked-foo`), recorded in `local-packages.json` so the
postinstall relink keeps it linked. Today:

- the scope is dropped, so the folder never matches localize's name;
- an existing folder is silently overwritten;
- nothing is linked or recorded, so a package outside `packages/` is invisible to the app;
- localize cannot take it over either: it always clones from a remote it resolves with
  `npm view`, and an unpublished package has neither;
- there is no git at all, and no way to choose any of this non-interactively.

Two repositories change: `@_linked/localize` (`packages-local/localize`) and `@_linked/cli`
(`packages-local/cli`). This doc lives in the CLI because the CLI is the user-facing half.

## Planning blockers (resolved)

1. Folder naming in each location.
2. How a brand-new, unpublished, possibly remote-less checkout gets linked and recorded.
3. Whether, and how, the app declares a dependency on a packages-local package.
4. What keeps the link alive across `npm install` in an app that has no relink hook.
5. Git: what runs, in which order, and which steps are outward-facing.
6. Flags vs prompts.
7. What "the app root" is, and what packages mode must do to the app.
8. An existing target folder.

## Accepted decisions

### 1. Folder naming
`packages-local/<checkoutNameFor(name)>` — the function localize already exports, so the two
can never disagree. `packages/` keeps the bare name, matching the tracked members CN already
has (`packages/access`, `packages/maps`).

### 2. localize gets an `adopt` mode (route 1b)
`linked-localize adopt <package…>` (beside `remove`) and `linked localize --adopt`:

- the checkout must already exist at `<dir>/<checkoutName>` and be a git checkout;
- its `package.json` must declare that name;
- `repo` comes from `--repo`, else `git remote get-url origin`, else is absent;
- then the same tail as `localize`: `npm install` inside the checkout, the optional build,
  the symlink, the manifest entry, and the "consumer manifests untouched" post-condition;
- it never clones, pulls, or touches a remote.

`repo` becomes **optional** in a manifest entry (`path` and `branch` stay required). A plain
`localize <name>` on an entry with no repo still resolves through the registry as before; its
"cannot read registry metadata" refusal now also names `adopt` when the checkout exists.

Rejected: create-package writing the manifest and symlink itself (route 1a) — two writers of
one file, and the old hand-moved checkouts would still have no command to adopt them.

### 3. The app does not declare the dependency in packages-local mode
Measured with npm 11.19.1 against an unpublished name:

| App declares | Result |
|---|---|
| `^0.1.0` | `E404` as soon as a lockfile exists (`npm install` and `npm ci`) |
| `file:packages-local/<x>` | installs, idempotent — but a teammate without the checkout gets a clean install and a dangling link; the failure is `Cannot find module` at runtime |
| `optionalDependencies` `^0.1.0` | with an existing lock, npm **deletes** the link |

So nothing is written to the app's `dependencies`. The local state lives where localize keeps
it: the gitignored manifest. Two consequences are handled:

- `build-all` narrows to "the app's dependency tree" and would skip the package. Packages
  recorded in `local-packages.json` now seed that tree — being localized is a declaration
  that this app is being developed against it.
- create-package prints the follow-up: after the first publish,
  `npm install <name>@^<version>` turns it into a normal dependency, and the link keeps
  winning while it stays localized.

### 4. The relink hook is added when missing
Without `linked localize --relink` in the app's `postinstall`, the next `npm install` prunes
the link as extraneous. The app template has no such hook. In packages-local mode
create-package adds it (sets `postinstall`, or appends `&& linked localize --relink`) and says
so. It is safe to commit: with no manifest the hook is silent and exits 0.

### 5. Git, in this order (packages-local mode only)
1. scaffold the files;
2. `git init`;
3. with `--remote`: `git remote add origin <url>` and fill `repository.url` (`git+<url>`);
4. adopt — install, build, link, record;
5. `git add -A && git commit` — after the install, so the lockfile is in the first commit
   (the template's `.gitignore` already excludes `lib`, `node_modules`, `*.tsbuildinfo`);
6. with `--push`: `git push -u origin HEAD`.

A failed commit (no git identity) or push warns and sets exit code 1; the package is still
linked and usable. Creating the remote repository itself (`gh repo create`, an org's
governance) stays out of the linked CLI — that remains `@semantu/cli`'s job for Semantu's own
repos. Plan 054 in Create Now said create-package stays git-free; that is corrected: choosing
the location and an optional remote belongs in the linked CLI.

### 6. Flags, and when to prompt
`--location <packages|packages-local>`, `--remote <git-url>`, `--push`. No `--yes`.

- `--remote` or `--push` without `--location` implies `packages-local`.
- Giving **any** of the three means no prompt is shown at all — flags given are taken as the
  complete answer.
- Otherwise, inside an app on a TTY: ask the location; in packages-local, ask for an optional
  remote; with a remote, ask whether to push (default no).
- Inside an app without a TTY and without a location: refuse, naming `--location`.
- `--push` without a remote, and a remote with `--location packages`, are refused.

### 7. The app root, and what packages mode does
The app root is the nearest ancestor whose `package.json` has `linkedApp: true` — true of CN
and of the app template (which has no `workspaces`, so the existing `findAppRoot` cannot see
it).

Packages mode:
- ensures the app's `workspaces` covers `packages/*` (absent → `["packages/*"]`; an array
  without it → appended; the object form → left alone with a warning);
- declares `"<name>": "^<version>"` in the app's `dependencies` — npm links a workspace member
  by name, and `build-all` needs it in the tree;
- runs the install at the **app root**, then builds the package.

Outside an app (no `linkedApp` ancestor) behaviour is unchanged: `<cwd>/packages`, else
`<cwd>/modules`, else `<cwd>`, install inside the package, no prompt. `--location` there is
refused, since both locations are defined relative to an app.

### 8. An existing target is refused
In every mode, before anything is written.

## Selected route

localize gains `adopt` and an optional `repo`; the CLI's `createPackage` gains a location
step, git steps and flags, and calls localize's `adopt` for packages-local; `build-all` seeds
its dependency tree from the localize manifest.

## Plan

### Contracts

**@_linked/localize** (0.1.0 → 0.2.0, minor: additive)

```js
adopt(names: string[], opts: {dir?, repo?, build?, force?}, deps) => number /* exit code */
```

- Refuses (exit 6) when `<dir>/<checkoutNameFor(name)>` is missing, is not a git checkout,
  or its `package.json` declares another name. `--repo` with several names is refused (exit 6)
  — a repo belongs to one package.
- Otherwise identical to `localize` from the install onward, and shares that code.
- Manifest entry: `{path, branch, repo?, subdir?, range?}` — `repo` optional, and `subdir` is
  now carried through `readManifest` (it was dropped on read, so a re-localize lost it).
- Bin: `linked-localize adopt <package…> [--dir] [--repo] [--build] [--force]`.

**@_linked/cli**

```
linked localize <package…> --adopt [--repo <url>] [--build <cmd>] [--force]
linked create-package <name> [uri_base] [--location packages|packages-local] [--remote <git-url>] [--push]
```

```ts
createPackage(name, uriBase?, basePath = process.cwd(),
              options?: {location?: 'packages'|'packages-local'; remote?: string; push?: boolean})
```

Function callers (Create Now's plan 057) pass `options`; with no location inside an app and
no TTY, it throws rather than prompting.

### File changes

localize:
- `src/localize.js` — extract the install → build → link → entry tail into a shared
  function; add the `adopt` hint to the registry-lookup refusal when the checkout exists.
- `src/adopt.js` (new) — the adopt loop.
- `src/manifest.js` — `repo` optional; carry `subdir`.
- `src/index.js`, `bin/linked-localize.js` — export and wire `adopt`.
- `test/commands.test.js`, `test/manifest.test.js` — adopt and optional-repo tests.
- `README.md`, `package.json` (0.2.0).

cli:
- `src/utils/createPackageLocation.ts` (new) — pure decisions: `findLinkedAppRoot`,
  `resolveCreatePackageTarget` (flags + TTY → mode/target/what to ask), `ensureWorkspaceGlob`,
  `ensureRelinkPostinstall`, `repositoryUrlFor`.
- `src/cli-methods.ts` — `createPackage` uses them; prompts; git steps; packages-mode app edits
  and root install; packages-local calls adopt.
- `src/commands/localize.ts` — `--adopt`; `adoptPackage()` helper used by createPackage.
- `src/cli.ts` — the new options.
- `src/lifecycle.ts` — `filterPackagesByDependencyTree` seeds from `local-packages.json`.
- `package.json` — `@_linked/localize: ^0.2.0`; a changeset.
- tests: `tests/unit/createPackageLocation.test.ts` (new), `buildAllDiscovery.test.ts`,
  `localizeCommand.test.ts`.

Create Now (docs only): `docs/how-to/develop-a-linked-package-locally.md` (create-package and
adopt), a correction note in plan 054.

### Pitfalls

- **adopt's post-condition** hashes the app's `package.json` around the adopt call. The
  relink-hook edit must happen outside that window (before adopt), or adopt exits 8.
- **The CLI resolves the registry localize** (0.1.0). Validation needs the local checkout
  linked into `cli/node_modules`, restored afterwards; release order is localize first.
- **The build** must be the running CLI's own launch script (as today), not `linked build`
  from PATH, which may be another version. It is passed to adopt as its build command.
- **readline on a non-TTY** hangs a script waiting for an answer — gate every prompt on
  `process.stdin.isTTY`.
- **git commit without an identity** fails; warn, keep going.
- **`writeLink` replaces a real directory** at `node_modules/<name>`. For a brand-new name
  that is a collision with an installed package; acceptable, and adopt's foreign-link guard
  still protects someone else's symlink.

## Tasks

### Phase 1 — localize: optional repo and `adopt`
1. `manifest.js`: `repo` optional in `validateEntry`; carry `repo` only when a string; carry
   `subdir`.
2. `localize.js`: extract `installLinkAndRecord(...)`; `localizeOne` uses it; the registry
   refusal names `adopt` when a git checkout already sits at the target.
3. `adopt.js`: the loop with its refusals; `repo` from `--repo` / origin / none.
4. Export from `index.js`; wire `adopt` in the bin, with usage text.
5. Tests: adopt links and records; records origin; records no repo without one; `--repo`
   wins; refuses missing / non-git / wrong name; never runs `git clone` or `git pull`;
   repo-less entry reads, lists and relinks; `subdir` survives a read.
6. README section; version 0.2.0.

**Validation:** `npm test` in localize passes (including the existing real-localize test).

### Phase 2 — CLI: `localize --adopt` and build-all seeding
1. Link the local localize into `cli/node_modules/@_linked/localize` for development.
2. `commands/localize.ts`: `adopt` option → `adopt(...)`; export `adoptPackage`.
3. `cli.ts`: `--adopt` on `localize`.
4. `lifecycle.ts`: seed the dependency tree from `local-packages.json`.
5. Tests: `localizeCommand.test.ts` (adopt passthrough), `buildAllDiscovery.test.ts`
   (a manifest-recorded package is not skipped as "not in the dependency tree").

**Validation:** `npx jest` on the touched unit tests passes; `npx linked build` (via the CLI's
own build) compiles.

### Phase 3 — CLI: create-package location, flags and git
1. `utils/createPackageLocation.ts` with unit tests for every flag/TTY combination, the
   workspace-glob and postinstall edits, and repository URL normalisation.
2. `createPackage`: app root, target, refuse-existing, prompts, packages mode (workspace glob,
   dependency, root install, build), packages-local mode (git init, remote, repository.url,
   relink hook, adopt, commit, push), unchanged outside an app.
3. `cli.ts`: `--location`, `--remote`, `--push`.
4. Dependency bump to `^0.2.0` and a changeset.

**Validation:** unit tests pass; full CLI unit suite has no new failures; the CLI compiles.

### Phase 4 — End to end and docs
1. In a scratch app (`linkedApp: true`, no workspaces) with the built CLI:
   - `--location packages-local --remote <bare repo> --push`: folder name, git log, origin,
     `repository.url`, link, manifest entry, postinstall hook, pushed commit; then
     `npm install` at the app root and the link survives (relink);
   - `--location packages`: workspaces, dependency, root install, link;
   - an existing target is refused; a non-TTY run without `--location` is refused;
   - outside an app: unchanged.
2. Docs: CN how-to and plan 054 note.

**Validation:** every scenario above observed, with output recorded in this doc.

### Dependencies

Phase 1 → Phase 2 → Phase 3 → Phase 4. Phase 2's build-all seeding has no dependency on
Phase 1 and could run beside it; kept sequential since it is small.

## Implementation log

### Phase 1 — done (localize `195bb33`, branch `feat/adopt`)

- `adopt.js`; `localize.js` now shares `forEachName` (manifest read/write, post-conditions)
  and `installLinkAndRecord` (install → build → link → entry) between `localize` and `adopt`.
- Validation: `npm test` — 47 tests, 47 pass, including the slow real-clone tests. Nine new:
  seven in `test/adopt.test.js`, two in `test/manifest.test.js`.
- The README's uncommitted wording edits (not part of this work) were left unstaged.

### Phase 2 — done (cli `2810b76`, branch `feat/create-package-location`)

- `linked localize --adopt`; `adoptPackage(name, {appRoot, build, repo})` returns the code.
- `localizedPackageNames()` in `lifecycle.ts` seeds `build-all`'s dependency tree; the stale
  "`semantu localize`" wording on `LOCAL_PACKAGES_DIR` is corrected.
- Dev setup: `cli/node_modules/@_linked/localize` is symlinked to `../../../localize`; the
  registry 0.1.0 copy was moved to the session scratchpad. `npm install` in the CLI restores it.
- Validation: `jest buildAllDiscovery localizeCommand` — 19 passed (4 new); `npm run build`
  compiles; `linked localize --help` lists `--adopt`.

### Phase 3 — done

- `utils/createPackageLocation.ts` (pure decisions) and the rewritten `createPackage` with
  `installStandalonePackage` / `installWorkspacePackage` / `installOwnRepoPackage`. A refusal
  is a `CreatePackageError`; the command prints its message and exits 1, a function caller
  gets the throw.
- `@_linked/localize` is bumped to `^0.2.0` in `package.json` only. **`package-lock.json` is
  not updated**: 0.2.0 is unpublished, so the lock can only follow once localize is released.
- Validation: `createPackageLocation.test.ts` 14 passed; full unit suite 461/461 in 40 suites;
  `npm run build` compiles; `create-package --help` shows the three options.

### Phase 4 — done, with findings

End to end in a scratch app (`linkedApp: true`, no workspaces, like the template), with the built
CLI and localize 0.2.0:

| Scenario | Result |
|---|---|
| `--remote <bare repo> --push` | exit 0; `packages-local/probe-alpha`; `feat: scaffold @probe/alpha` pushed to the bare remote; `repository.url` set; link and manifest entry; postinstall hook added; no app dependency; clean tree |
| app-root `npm install` afterwards | the postinstall relinked it — **but the checkout's `node_modules` was emptied** (finding B) |
| `--location packages-local`, no remote | entry recorded with no `repo`; "no remote yet" hint |
| `--location packages` | `workspaces: ["packages/*"]`, `"@probe/gamma": "^1.0.0"`, lock entry `resolved: packages/gamma`, link, `lib/` |
| existing target, non-TTY no flags, `--push` alone, `--location packages --remote`, bad location | all exit 1 with their message; nothing written, manifests byte-identical |
| outside an app | unchanged behaviour; `--location` refused |
| `build-all` | built `@probe/alpha` and `@probe/beta` (localized, undeclared) beside `@probe/gamma` |

## Review

1. **A — branch recorded as `HEAD`** (medium). Adopt runs before the first commit; on an unborn
   branch `git rev-parse --abbrev-ref HEAD` fails. → fixed in iteration 1.
2. **B — a root `npm install` empties the `node_modules` of every checkout inside the app root**
   (high, **pre-existing in localize**). Measured on npm 11.19.1: npm counts a linked checkout
   under the root as part of the root's tree (`npm ls` marks its deps `extraneous`) and prunes
   them; it happens for a localized *published* dependency too (declared, registry range), with
   or without workspaces, relative or absolute link. A checkout *outside* the app root keeps its
   `node_modules` (only the link goes). `npm ci` does not do it. The relink restores the link,
   never the deps, so the checkout's own build breaks until `npm install` is run in it again.
   Fixing it means relaxing "relink never invokes npm", or moving checkouts out of the app root,
   or something else — **a localize design decision for the user**, not taken here.
3. **C — version skew on the manifest** (medium). A localize older than 0.2.0 skips a repo-less
   entry as malformed, and the app's postinstall runs whichever `linked` npm hoisted. Release
   order handles it: publish localize 0.2.0, then the CLI that requires it. → noted in the
   changeset; nothing to build.
4. Low: every scaffold printed `Could not read file …/Gruntfile.js` (the template has none) →
   fixed in iteration 1.
5. Low, pre-existing, left: the four absolute-path `rename` log lines; standalone mode advises
   "build once" after it already built; build-all's progress text runs into its Info lines; the
   new repo's first lockfile once carried an `extraneous` entry.

## Iteration 1 — Ideation

### Gap 1 of 3: branch on an unborn repository
Commit before adopting (loses the lockfile from the first commit) vs. ask git differently.
**Chosen:** `git symbolic-ref --short -q HEAD` first, `rev-parse` as the detached fallback, in
localize's `currentBranch` — correct for every caller, not only create-package.

### Gap 2 of 3: manifest version skew
**Chosen:** no code. The changeset says the CLI needs localize 0.2.0; release localize first.

### Gap 3 of 3: the Gruntfile warning
**Chosen:** drop `Gruntfile.js` from the substitution list.

Finding B is held for the user.

## Iteration 1 — Plan and phases

### Phase 5 — fixes
- localize `currentBranch` (commit `4ac6be3`), with a real-git test of an unborn branch.
- CLI: `Gruntfile.js` out of the substitution list.

**Validation:** localize `npm test` 48/48; CLI rebuilt; a fresh
`create-package @probe/epsilon --location packages-local` recorded `"branch": "main"`, committed
`feat: scaffold @probe/epsilon`, and printed no Gruntfile warning.
