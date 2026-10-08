---
summary: >
  `linked localize` / `linked delocalize` — develop an npm dependency from a git checkout without
  touching package.json or the lockfile. How it works, monorepos, adopt, building, the one-copy
  rule (pruning, the run-time check, Vite's dedupe), --list, local-packages.json, exit codes.
---

# `linked localize` — develop a dependency from a git checkout

```sh
npx linked localize some-dependency
```

That clones `some-dependency`'s repository into `packages-local/`, installs its dependencies
**inside the checkout**, builds it with `linked build`, and symlinks `node_modules/some-dependency`
at it. Your app now runs the checkout. Edit it, commit it, push it. When you are done:

```sh
npx linked delocalize some-dependency
```

Localize used to be a separate package, `@_linked/localize` (binary `linked-localize`). It is now
part of this CLI and `@_linked/localize` is being retired (no longer developed; not yet marked
deprecated on npm). Use `linked localize`.

## The problem

You are working on an app and find a bug in one of its dependencies — a package you also maintain.
You want to fix it and see the fix in the running app before publishing anything. Every existing
way of doing that has a catch:

| | the catch |
|---|---|
| `npm link` | writes into a global directory, and its symlink resolution surprises people in ways that are hard to debug |
| `npm install ../path` | **rewrites `package.json` and the lockfile.** You now have a diff you must remember not to commit, and CI installs something different from what you tested |
| `"dependency": "file:../path"` in `package.json` | same, but permanent and committed |
| npm/pnpm/yarn workspaces | you have to restructure the repository, and the package becomes part of *your* project |
| a monorepo tool | you have to adopt a monorepo tool |

`linked localize` makes the change **entirely outside the files npm reads**. Your `package.json`
and `package-lock.json` come out byte-for-byte identical — it hashes them before and after and
exits non-zero if they moved. CI, which never has the checkout, installs from the registry as
always.

## How it works

```
npm package name
  → the published `repository` field           (data, not a guess)
  → git clone into packages-local/<name>
  → npm install INSIDE the checkout            (never in your project)
  → prune what the app already provides        (one copy of each; --no-prune skips)
  → build it (`linked build`, or --build)      (a failure only warns)
  → fs.symlink node_modules/<name> → checkout  (not npm link)
  → record it in local-packages.json           (gitignored)
```

Checkouts go in `packages-local/` under the npm name with the scope flattened: `@_linked/rdfs` →
`packages-local/_linked-rdfs`. `--dir` moves that directory.

**The repository comes from the registry.** `linked localize` runs `npm view <name> repository` —
metadata the package already published. No mapping table, no org to configure, no guessing, and it
works for a private registry because `npm view` uses whatever registry and token you have. A
package that publishes no `repository` is refused with a hint to pass `--repo` once. Name packages
exactly as npm names them (`@_linked/rdfs`, `lodash`); there are no short names or aliases.

**`npm install` runs inside the checkout.** Node resolves a symlinked package's dependencies from
the symlink's *real* path, `packages-local/<name>/`. The checkout needs its own install for
whatever the app does **not** provide; what the app does provide is removed again (see
[one copy](#one-copy-of-what-the-app-provides)), so Node's upward search reaches the app's copy.
`tests/unit/localize/real-localize.test.ts` runs a real clone and a real install to hold this line.

**The symlink is written with `fs.symlink`, not by invoking npm.** npm is never run against your
project by any code path — its peer-dependency resolution breaks the checkout, and a `postinstall`
hook that installs would recurse.

**The record is a gitignored file, which makes CI a no-op by construction.** CI has no
`local-packages.json`, so `--relink` finds nothing and prints nothing.

## Set-up

Add to `.gitignore`:

```gitignore
packages-local/
local-packages.json
```

And, so `npm install` or `npm ci` does not quietly undo your links:

```json
{ "scripts": { "postinstall": "linked localize --relink" } }
```

`npm ci` deletes `node_modules` and exits 0, taking the symlinks with it and leaving you running
the registry copy while you edit the checkout — the state that costs hours, because nothing reports
it. `--relink` restores the links, always exits 0, and prints nothing when there is nothing to do.

A plain `npm install` also counts a checkout under your project as part of your tree, marks its
dependencies `extraneous` and **deletes them** (measured on npm 11). So `--relink` checks each
checkout's declared dependencies and, when any are gone, reinstalls **inside that checkout**
(install, then prune — the same step as `--reinstall`), never in your project.

`npm install <name>` — with a package name — does **not** run the app's own `postinstall`, so it
replaces every localized link with the registry copy, silently. Run `linked localize --relink`
after it.

## Commands

```sh
linked localize <package…>             clone, install, build, link, record
linked localize <package…> --adopt     the same for a checkout already in packages-local/, no clone
linked localize                        what is localized (same as --list)
linked localize --list --check         exit 1 when something recorded is not linked
linked localize --relink               recreate the recorded links (for postinstall)
linked localize --ensure               remove checkouts' own copies of what the app provides; exit 0 (no names)
linked localize --reinstall <package>  npm install inside that checkout, then prune it
linked delocalize <package…>           unlink and forget; keep the checkout
linked delocalize                      undo everything
linked delocalize <package> --purge    also delete the checkout (refuses on unsaved work)
```

| option | |
|---|---|
| `--dir <path>` | where checkouts live. Default `packages-local` |
| `--repo <git-url>` | clone this instead of the published `repository`, and record it. With `--adopt`: record this instead of the checkout's `origin` |
| `--subdir <path>` | where the package lives inside the repository (monorepos) |
| `--build "<cmd>"` | run this in the checkout after installing instead of `linked build`; `""` builds nothing. A failure only warns |
| `--no-prune` | leave the checkout's `node_modules` exactly as npm installed it. With a package to localize or `--adopt` it is **recorded** (`"prune": false`), so `--relink`, `--reinstall` and the run-time check leave that checkout alone from then on; localizing it again without the flag turns pruning back on. With `--relink` or `--reinstall` alone it applies to that run; `--ensure --no-prune` does nothing |
| `--force` | replace a symlink pointing outside `--dir`; with `delocalize --purge`, delete anyway |

Use `--reinstall <package>` instead of running `npm install` in a checkout by hand: a hand-run
install puts back the checkout's own copies of what the app provides; `--reinstall` takes them out
in the same step. (If you do run it by hand, the next `linked start` removes them — see below.)

### Packages published from a monorepo

If the package sets `repository.directory` — npm's own field for this — localize clones the whole
repository and installs and links that directory inside it. Nothing to configure.

If it does not, localize clones the repository, sees that the root is a different package, and
**refuses rather than link the wrong thing**. Tell it where to look, once:

```sh
linked localize @scope/thing --subdir packages/thing
```

Both `--repo` and `--subdir` are written into `local-packages.json`, so you pass them the first time
and never again.

### A checkout that is already there: `--adopt`

Some checkouts cannot come from the registry: a package you just created and have not published,
perhaps with no remote yet (`linked create-package --location packages-local` hands it to
`--adopt`), or a clone you put in `packages-local/` by hand. `--adopt` takes the checkout as it is:

```sh
linked localize @scope/thing --adopt
```

It expects a git checkout at `packages-local/scope-thing` (the name localize would clone to) whose
`package.json` is named `@scope/thing`, and then does what localize does from the install onward:
install inside it, prune, build, link, record. **It never clones, pulls or fetches.** The recorded
`repo` is the checkout's `origin`, or `--repo`, or nothing — a package with no remote relinks and
lists like any other. It takes no `--subdir`. Localize suggests `--adopt` itself when a registry
lookup fails and a checkout is already where the clone would go.

### Building the checkout

The build is `linked build`, run in the checkout after the install. `--build "<cmd>"` replaces it
and `--build ""` builds nothing. A failing build only warns and the package is linked anyway — a
package whose build is broken is usually exactly what you localized it to fix.

## One copy of what the app provides

The install inside a checkout installs what the *checkout's* lockfile says: its own copy of
everything it depends on, often older than the app's. Node resolves a module from the importer's
real path and stops at the first `node_modules` it meets, so with two localized packages where `A`
depends on `B`:

- `A` imports the registry `B` in `packages-local/A/node_modules`, not the localized `B` you are
  editing;
- a package that must be loaded once — React, or anything that keeps a registry of classes — is
  loaded once per copy. `tsc`, plain Node, `tsx` and test runners all see the duplicates.

### The rule

What the app provides is **one rule** (`providedPackages`, `src/localize/provided.ts`), and
pruning, the run-time check and Vite's `resolve.dedupe` all start from it:

- every **localized package** the app has installed — always, whatever a range says;
- every **runtime dependency** (`dependencies`, `peerDependencies`, `optionalDependencies`) a
  localized checkout declares, when the app has it at a version that satisfies **every** localized
  checkout's range for it. A range the app's version misses, or one that cannot be read, leaves the
  name out;
- `react` and `react-dom` when the app has them.

Pruning takes the rule **per checkout**: in checkout `A`, a candidate is a localized sibling,
`react`/`react-dom`, or one of `A`'s *own* runtime dependencies that the rule provides. `A`'s
devDependencies are never candidates — not even when another checkout depends on the same package at
runtime — so a checkout's own tooling stays its own.

### Pruning

After every install in a checkout (localize, `--adopt`, `--reinstall`, relink's reinstall) and on
every `--relink`, a candidate at the top of a checkout's `node_modules` is removed when the app has
it at `node_modules/<name>` at a version satisfying every range that would load that copy — the
checkout's own, and that of any installed package without a copy of its own. A localized sibling
counts whatever its version; a range it misses is reported, not acted on.

A copy is also kept when removing it would change what **its own** dependencies resolve to: when
one of its `dependencies`/`peerDependencies`/`optionalDependencies` (or the `@types/` package
TypeScript would take for it) resolves, from the copy's place in the checkout, to a different version
than from the app's copy. The checkout keeps its own copy of everything that failed the range check,
so removing the copy would mix the two — for example a checkout that keeps React 18 for its own range
would see its renderer library switch to the app's React 19 types, and its own `tsc` fail.

A removal can make another copy removable, so pruning repeats until a pass removes nothing: one
command converges. Kept copies are summarised in one line per checkout:

```
[localize] packages-local/scope-thing: kept 3 own copies the app's cannot replace: react@18.3.1 (app 19.2.0), react-dom@18.3.1 (app 19.2.0), prism-react-renderer@2.4.1 (its react would change) — so the app loads them twice. `linked localize --list` says why.
```

`--list` gives the full reason for each.

This includes tooling a checkout declares as a runtime dependency — a checkout's own `vite` or
`typescript`, for instance, when the app has them in range. The checkout still builds and runs its
tests: Node's upward search reaches the app's copy, and npm puts every ancestor's
`node_modules/.bin` on the `PATH` for `npx`, `npm exec` and `npm run`, so `npx linked build` in a
checkout runs the app's `linked`. The removed package's links in `node_modules/.bin` go with it.

A checkout outside your app's root is never touched. Nothing is written to the checkout's
`package.json` or `package-lock.json`. Inside the checkout, `npm ls` reports the removed packages as
`UNMET DEPENDENCY`; that is npm not looking above the package's own root, not a broken checkout.

### The run-time check

An `npm install` in a checkout puts the copies back, and nothing above would notice until the next
localize command. So `linked start`, `linked script`, `linked call` and `linked build-all` first run
a cheap check: would pruning remove anything? It makes the same per-copy decision as pruning — the
per-checkout candidates, the range check, the resolution check — without removing anything, and
prunes only when that decision removes something. Then it prints one line, on stderr:

```
[localize] one copy: removed packages-local/fw-a/node_modules/@fw/core@2.20.0 — the app provides it.
```

It never runs npm and never walks a checkout's `node_modules`: each candidate is a direct lookup,
and the ranges other installed packages ask come from npm's hidden lockfile
(`node_modules/.package-lock.json`, one read per checkout that needs it; a tree npm did not write is
walked once instead). Measured on an app with 21 localized checkouts and 54 kept copies: about 40–50 ms,
next to roughly a second for the CLI itself to start. It prints nothing when there is nothing to
remove, skips a checkout recorded with `"prune": false`, and never fails the command it runs before.
For anything else that loads the app's code (a type check, a test runner), run it from an npm `pre*`
script:

```json
{ "scripts": { "pretest": "linked localize --ensure" } }
```

`linked localize --ensure` runs the same check and always exits 0. It takes no package names (it
refuses them with exit 2 rather than check only those); `--reinstall <package>` is the per-checkout
command.

### Vite

The dev server gets the same guarantee from `resolve.dedupe`, which `createViteConfig` derives from
the same rule. On top of it, Vite leaves out a name some registry install nests its own copy of — a
dedupe hands every importer the app's copy without checking versions. With nothing localized, only
React is deduped. The dedupe covers what Vite loads; pruning covers everything else.

## `linked localize --list`

The record of what you *intended* and the symlinks that are actually there can disagree. `--list`
reads the symlinks first and reports the disagreement:

```
@scope/thing   linked       packages-local/scope-thing   main
other-pkg      NOT LINKED   packages-local/other-pkg     main       checkout present
gone-pkg       NOT LINKED   packages-local/gone-pkg      —          CHECKOUT MISSING
stray          linked       ../elsewhere/stray           —          not in local-packages.json
leftover       UNRECORDED   packages-local/leftover      —          directory not in local-packages.json

1 linked · 2 not linked · 1 untracked link · 1 unrecorded directory
```

A linked checkout whose `node_modules` holds copies pruning keeps shows `kept N own copies`, and the
reasons follow the table — who asks which range the app's version misses, or which dependency would
resolve elsewhere; the summary line counts them (`· 54 kept copies`). A checkout recorded with
`"prune": false` shows `prune: off`.

- **`checkout present`** — the checkout is there, the symlink is not: what `npm install`/`npm ci`
  leaves behind. `linked localize --relink` fixes it.
- **`CHECKOUT MISSING`** — recorded, but nothing on disk. `linked localize <name>` clones it again.
- **`not in local-packages.json`** — a symlink localize did not create. Reported, never touched.
- **`UNRECORDED`** — a directory in `packages-local/` that no record and no link accounts for. The
  app does not run it and nothing prunes it; `linked localize <name> --adopt` takes it in, or delete
  it.

`--list` never writes and always exits 0. `--check` exits 1 when something recorded is not
actually linked (an unrecorded directory does not fail it).

## `local-packages.json`

```json
{
  "version": 1,
  "packages": {
    "@scope/thing": {
      "repo": "https://github.com/scope/thing.git",
      "path": "packages-local/scope-thing",
      "branch": "main",
      "range": "^2.1.0"
    },
    "other-pkg": {
      "path": "packages-local/other-pkg",
      "branch": "main",
      "prune": false
    }
  }
}
```

Gitignored, written atomically, and **never repaired**: if it is unparseable or carries a schema
version this build does not know, localize refuses to read *or* rewrite it and says where it is. It
is the only record of what you intended, and silently resetting it is how a half-localized tree
becomes invisible.

`repo` is absent for a package adopted with no remote; `subdir` is present for a package that lives
inside a monorepo. `prune` is present, as `false`, only for a package localized or adopted with
`--no-prune`: nothing is ever pruned in that checkout (it still counts as a localized sibling in the
others). Older readers of schema version 1 ignore it.

`range` is informational. **npm matches a linked package by name and never checks its version**, so
a checkout at `2.0.99` satisfies `^3.0.0` as far as your tree is concerned and `npm ls` will not
flag it. Localize warns about that drift and never uses it to decide anything.

## Exit codes

| | |
|---|---|
| 0 | fine |
| 1 | `--list --check` found something recorded but not linked |
| 2 | bad command line |
| 3 | `local-packages.json` is unusable; nothing was read or written |
| 4 | no repository could be resolved. Pass `--repo` |
| 5 | something was warned about and skipped; the rest worked |
| 6 | a guard refused. `--force` overrides |
| 7 | `npm install` failed inside the checkout. Nothing linked, nothing recorded |
| 8 | your `package.json` or lockfile changed while the command ran |

Each package on the command line is processed independently, and the exit code is the highest of
the per-package codes — a failure on the second name does not undo the first. `--relink` and
`--ensure` always exit 0.

## What it never does

- run an install against *your* project
- remove anything from a checkout's `node_modules` but a copy of what your app provides (and never
  with `--no-prune`, or in a checkout recorded with `"prune": false`)
- edit `package.json`, `package-lock.json`, `.gitignore`, `workspaces`, or any bundler configuration
- invoke `npm link`
- delete a checkout you have not committed or pushed (without `--force`)
- guess at a repository URL

## Programmatic use

```ts
import {localize, relink, checkOneCopy, defaultDeps} from '@_linked/cli/localize/index.js';

const deps = defaultDeps(process.cwd());
const code = localize(['@scope/thing'], {build: 'npm run build'}, deps);
```

The functions are synchronous and return an exit code from the table above. Each takes a `deps`
object — `{appRoot, run, log, warn, error}` — so you can point it at another directory or capture
its output; `defaultDeps()` builds the usual one.
