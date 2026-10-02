---
date: 2026-10-02
summary: >
  `linked create-package` now places a package inside an app: `packages/` (part of the app's
  repository — a workspace member, declared, installed at the app root) or `packages-local/`
  (a repository of its own — localize's folder name, `git init`, a first commit, optional
  `--remote`/`--push`, handed to `linked localize --adopt`). Chosen with `--location`, `--remote`,
  `--push`, or asked on a terminal. `build-all` builds localized packages the app does not
  declare yet. Measured along the way: an unpublished package cannot be declared by range or
  `file:` safely, and a root `npm install` prunes every checkout under the app root — fixed in
  `@_linked/localize` 0.2.0's relink.
---

# 009 — create-package: `packages/` or `packages-local/`

## The problem

`create-package` wrote into `<cwd>/packages/<bare-name>`. In an app that uses `linked localize`,
`packages/` holds only packages that live in the app's own repository; a package with its own
repository belongs in `packages-local/`, under localize's scope-flattened name
(`@_linked/foo` → `packages-local/_linked-foo`), recorded in `local-packages.json` so the
postinstall relink keeps it linked. Before this change:

- the scope was dropped, so the folder never matched localize's name;
- an existing folder was silently overwritten (`ensureFolderExists` + `copySync`);
- nothing was linked or recorded, so a package outside `packages/` was invisible to the app;
- localize could not take it over: it always clones from a remote resolved with `npm view`, and
  an unpublished package has neither;
- there was no git at all, and no way to choose any of this non-interactively.

The work spans two repositories: `@_linked/localize` gained `adopt` (its own report,
`localize/docs/reports/001-adopt-and-relink-reinstall.md`), and this CLI gained the location step.

## How it works now

```
linked create-package <name> [uri_base] [--location packages|packages-local] [--remote <git-url>] [--push]
linked localize <package…> --adopt [--repo <url>] [--build <cmd>] [--force]
```

```ts
createPackage(name, uriBase?, basePath = process.cwd(),
              options?: {location?: 'packages' | 'packages-local'; remote?: string; push?: boolean})
```

### 1. Find the app, decide the target

- **App root** = the nearest ancestor whose `package.json` has `linkedApp: true`
  (`findLinkedAppRoot`). Not the older `findAppRoot`, which requires `workspaces` — the app
  template has none.
- **Decision table** (`decideCreatePackageTarget`, pure):

| Situation | Result |
|---|---|
| no app above | `outside` — the old behaviour, unchanged |
| no app above + any of the three flags | refused |
| `--location` not `packages`/`packages-local` | refused |
| `--push` without `--remote` | refused |
| `--remote` with `--location packages` | refused |
| any of `--location` / `--remote` / `--push` | resolved; `--remote`/`--push` alone imply `packages-local` |
| no flags, terminal | ask |
| no flags, no terminal | refused, naming `--location` |

  Any flag is taken as the complete answer, so a scripted call never meets a prompt. There is no
  `--yes`. The prompt asks the location, then (packages-local) an optional remote, then (with a
  remote) whether to push, default no.
- **Target folder**: `packages/<bareName>`, or `packages-local/<checkoutNameFor(name)>` — localize's
  own exported function, imported at runtime, so the two cannot disagree. Outside an app:
  `<cwd>/packages`, else `<cwd>/modules`, else `<cwd>`, as before.
- **An existing target is refused in every mode**, before anything is written.

A refusal is a `CreatePackageError`: the command prints the message in red and exits 1; a
function caller gets the throw.

### 2. Scaffold

Unchanged: copy `defaults/package/`, rename the shipped dotfiles, substitute variables, rename
the ontology files. `Gruntfile.js` left the substitution list — the template has none, and every
scaffold printed `Could not read file …/Gruntfile.js`.

### 3. The three tails

**Outside an app** (`installStandalonePackage`) — as before: install inside the package (yarn only
inside a yarn project), build with the running CLI's own launch script.

**`packages/`** (`installWorkspacePackage`):
1. `ensureWorkspaceGlob` — `workspaces` absent → `["packages/*"]`; an array (or
   `{packages: [...]}`) without `packages/*` or `packages/**` → appended; any other shape → left
   alone with a warning.
2. `"<name>": "^<version>"` into the app's `dependencies` — npm links a workspace member by name,
   and `build-all` builds what the app depends on.
3. Install at the **app root**, then build the package.

**`packages-local/`** (`installOwnRepoPackage`), in this order:
1. `git init`.
2. With a remote: `git remote add origin <url>`, and `repository: {type: 'git', url}` in the
   package's `package.json` (`repositoryUrlFor`: `https://…` → `git+https://…`,
   `git@host:path` → `git+ssh://git@host/path`, a plain path stays as is). That field is what
   later `npm view` / `localize` resolution and `setup-publish` read.
3. `ensureRelinkPostinstall` on the app — sets `postinstall` to `linked localize --relink`, or
   appends `&& linked localize --relink`, unless one already relinks. **Before** adopt, never
   during: adopt asserts the app's `package.json` did not change while it ran (exit 8).
4. `adoptPackage(name, {appRoot, build})` — localize's `adopt`: `npm install` inside the checkout,
   the build (the running CLI's launch script, not `linked` from PATH), the symlink, the manifest
   entry. `EXIT_WARNED` (build failed) warns and continues; anything else non-zero stops, saying
   what is already in place and that `linked localize <name> --adopt` retries.
5. `git add -A && git commit -m "feat: scaffold <name>"` — after the install, so the lockfile is
   in the first commit. No git identity → warning, exit 1, package still linked.
6. With `--push`: `git push -u origin HEAD`. Failure → warning and the command to run.

git runs through `spawnSync` with an argument array, so a URL is never re-parsed by a shell.

**The app's `dependencies` are not touched in this mode.** The closing message says so, and
prints `npm install <name>@^<version>` for after the first publish; with no remote it also prints
how to add one later (`git remote add origin <url>`, then `linked localize <name> --adopt` to
record it).

## Key decisions and why

### The app does not declare an unpublished packages-local package

Measured with npm 11.19.1 against an unpublished name:

| App declares | Result |
|---|---|
| `^0.1.0` | `E404` as soon as a lockfile exists (`npm install` and `npm ci`); only works by accident with no lockfile |
| `file:packages-local/<x>` | installs, idempotent, hoists the checkout's deps to the app root — but a teammate without the checkout gets a **clean install** and a dangling link; the failure is `Cannot find module` at runtime |
| `optionalDependencies` `^0.1.0` | skips the 404, but with an existing lock npm **deletes** the link |

So the local state lives where localize keeps it, the gitignored manifest. The consequence for
`build-all` is handled below.

### `build-all` builds what is localized

`build-all` narrows to the app's dependency tree, which would skip a localized-but-undeclared
package as "not in the dependency tree". `localizedPackageNames(appRoot)` (in `lifecycle.ts`)
reads `local-packages.json` tolerantly — missing or unreadable means nothing localized — and its
names seed the tree alongside `dependencies`. Being localized is itself a statement that this
app is developed against the package.

### localize owns the manifest (adopt, not a second writer)

create-package could have written `local-packages.json` and the symlink itself. Instead localize
gained `adopt`, so one package writes that file, the hand-moved checkouts get a real command, and
`linked localize --adopt` is available directly.

### Location and remote belong in the open-source CLI

Create Now's plan 054 had put "placement" in the first-party `@semantu/cli`. Choosing between
`packages/` and `packages-local/` and wiring an optional remote is structure every user needs and
assumes no organisation, token or network — so it lives here. *Creating* the remote repository in
an organisation and protecting it stays first-party; that tool calls
`create-package --remote <new repo>` once the repo exists. Plan 054 carries a correction note.

### The pruned checkout (found during validation)

A root `npm install` counts a linked checkout under the app root as part of the root's tree,
marks its dependencies `extraneous` and deletes them — for a localized *published* dependency
too, with or without workspaces, relative or absolute link. A checkout outside the root keeps its
`node_modules`; `npm ci` does not prune. relink restored the link but not the deps, so the
checkout could no longer build. **Fixed in localize 0.2.0**: relink runs `npm install` inside a
checkout whose declared dependencies are missing (never at the root). The cost is that install
after every root `npm install`, because npm prunes again each time. Moving checkouts out of the
app root was rejected: build-all discovery, Vite and the docs all assume `packages-local/` under it.

## Files

| File | Responsibility |
|---|---|
| `src/utils/createPackageLocation.ts` (new) | Pure decisions: `findLinkedAppRoot`, `decideCreatePackageTarget`, `bareName`, `ensureWorkspaceGlob`, `ensureRelinkPostinstall`, `repositoryUrlFor`, `CreatePackageError`, `PACKAGE_LOCATIONS`, `RELINK_COMMAND` |
| `src/cli-methods.ts` | `createPackage` and its helpers: `askPackageLocation`, `packageSetupFor`, `installThenBuild`, `installStandalonePackage`, `installWorkspacePackage`, `installOwnRepoPackage`, `git` |
| `src/cli.ts` | `create-package` options and refusal handling; `localize --adopt` |
| `src/commands/localize.ts` | `--adopt` → localize's `adopt`; `adoptPackage()` returns the exit code for create-package |
| `src/lifecycle.ts` | `localizedPackageNames`; dependency-tree seeding in `filterPackagesByDependencyTree` and `planBuildAll` |
| `package.json` | `@_linked/localize` `^0.2.0` |
| `.changeset/create-package-location.md` | minor |

## Tests

- `tests/unit/createPackageLocation.test.ts` (new, 14) — the whole decision table, app-root
  discovery from a subfolder and its absence, workspace-glob edits (absent, covered, appended,
  object form, unknown shape), postinstall edits, `repository.url` spelling, `bareName`.
- `tests/unit/buildAllDiscovery.test.ts` (+2) — a manifest-recorded undeclared package is built;
  an unreadable manifest is "nothing localized".
- `tests/unit/localizeCommand.test.ts` (+3) — `--adopt` reaches `adopt` with the build seam;
  `adoptPackage` returns rather than setting `process.exitCode`; `--adopt` with no names or with
  `--subdir` is refused (exit 2) instead of falling through to the listing.
- Full unit suite: 462/462 in 40 suites.

End to end, with the built CLI and localize 0.2.0, in a scratch app shaped like the template
(`linkedApp: true`, no workspaces): packages-local with a bare remote and `--push` (folder name,
pushed `feat: scaffold` commit, `origin`, `repository.url`, link, manifest entry, postinstall,
clean tree, no app dependency); packages-local without a remote; `--location packages`
(workspaces, dependency, lock entry `resolved: packages/gamma`, link, build); all five refusals
leaving manifests byte-identical; outside an app; `build-all` building the two undeclared
localized packages; and a root `npm install` after which relink reinstalled the pruned checkouts
and `linked build` in one exited 0.

## Release order and known limits

- **Publish `@_linked/localize` 0.2.0 before this CLI.** An older localize skips a repo-less
  manifest entry as malformed, and an app's postinstall runs whichever `linked` npm hoisted — in
  the validation app a workspace member's devDependency pulled in a registry CLI that did exactly
  that. This branch's `package-lock.json` still resolves localize 0.1.0 and is updated once 0.2.0
  is on the registry.
- The relink reinstall repeats after every root `npm install` while something is localized.
- Left as they were (pre-existing, low): the four absolute-path `rename` log lines per scaffold;
  standalone mode advising "build once" after it already built; `build-all`'s progress text
  running into its Info lines.
- No `gh repo create` here, by design (see above).

## Related documentation

- `docs/reports/007-localize-command.md` — the `linked localize` adapter this builds on.
- `@_linked/localize` README — `adopt`, the manifest, the relink reinstall.
- Create Now: `docs/how-to/develop-a-linked-package-locally.md` (creating a package, `--adopt`,
  the postinstall contract) and `docs/plans/054-package-creation-and-governance.md` (correction).
