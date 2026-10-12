---
summary: >
  `linked localize` / `linked delocalize` — develop an npm dependency from a git checkout that the
  app's `"packages-local/*"` workspace glob makes a member, so npm links and dedupes it. How it
  works (glob, lock-at-rest hook, git hooks, drift check), the one-time app set-up and how to
  commit it, commands, monorepos (`.repos/`), building (incl. the cli), drift, parking, changing
  dependencies while localized, Docker/CI, migrating from the old localize, exit codes.
---

# `linked localize` — develop a dependency from a git checkout

```sh
npx linked localize some-dependency
```

That clones `some-dependency`'s repository into `packages-local/`, runs one `npm install` at the
app root (npm links the checkout as a workspace member) and builds it. Your app now runs the
checkout. Edit it, commit it, push it. When you are done:

```sh
npx linked delocalize some-dependency
```

This page is for app developers who also maintain some of the framework packages their app uses.

## The problem

You find a bug in a dependency you also maintain, and want to see the fix in the running app
before publishing anything. `npm link` and `npm install ../path` both work against you:
the first through a global directory, the second by rewriting `package.json` and the lockfile,
which you must then remember not to commit. And whatever links the checkout must also keep **one
copy** of each shared package: a checkout with its own `@_linked/core` or React splits the app in
two.

npm workspaces already link and dedupe local packages. What they do not do on their own is keep
the committed lockfile clean. That is the part `linked localize` adds.

## How it works

```
app/package.json   "workspaces": ["packages/*", "packages-local/*"]     committed once
                   postinstall + dependencies → lock-at-rest hook        committed once
app/packages-local/<checkout>/     git checkouts = workspace members    gitignored
app/.packages-local.parked/        parked checkouts (delocalize)        gitignored
.git/hooks/{pre-commit,post-merge,post-checkout}                        written by localize, per clone
```

- **The glob.** The app lists `"packages-local/*"` in its `workspaces`. Every directory there with
  a `package.json` is a workspace member, so `npm install` links `node_modules/<name>` to it and
  dedupes everything below it, exactly as for `packages/*`. Where `packages-local/` is empty or
  absent — CI, Docker, a fresh clone — the glob matches nothing and installs are unchanged.
- **Lock at rest.** With checkouts present, npm rewrites `package-lock.json` to list them. The
  app's `postinstall` and `dependencies` scripts run
  `node node_modules/@_linked/cli/hooks/lock-at-rest.cjs`, which puts the committed lockfile back
  (`git checkout HEAD -- package-lock.json`). `node_modules` stays linked; only the file goes back.
  The hook is plain, unbuilt CommonJS shipped in this package, so it runs even when the cli itself
  is a fresh checkout without `lib/`. It does nothing when no checkout is present, when there is
  no git or no work tree, or when git refuses (Docker's `safe.directory`), and it never fails the
  install.
- **Git hooks.** `linked localize` writes `pre-commit`, `post-merge` and `post-checkout` into the
  clone's own hooks directory. `pre-commit` refuses a staged `package.json` or
  `package-lock.json` that names a checkout (`"packages-local/<dir>"`); the other two run
  `npm install` when the dependency manifests changed. Nothing is committed for this, and only
  clones that localize get them.
- **The drift check.** npm links a checkout by name whatever its version, and is silent about the
  copies that result. `linked localize --list` reports them (see [drift](#drift)); the lock-at-rest
  hook prints them after every install, and `linked start`, `script`, `call` and `build-all` print
  them on stderr before they run. Drift is reported, never acted on, and never fails a command.

**Why the working tree stays clean.** `package.json` is committed with the glob once and never
changes again; the lockfile is restored after every install; the checkouts and parked checkouts
are gitignored. So `git status` is clean while you work, and pulls, merges, rebases and branch
switches never stop on a lockfile you did not mean to change.

**Where checkouts go.** Under the npm name with the scope flattened: `@_linked/rdfs` →
`packages-local/_linked-rdfs`.

**The repository comes from the registry.** `linked localize` runs `npm view <name> repository`,
the metadata the package already published, using whatever registry and token npm has. A package
that publishes no `repository` is refused with exit 4 and a hint to pass `--repo`. Name packages
exactly as npm names them (`@_linked/rdfs`, `lodash`); there are no short names.

**The record is the directories.** Every checkout in `packages-local/` is localized, every one in
`.packages-local.parked/` is parked. There is no other file.

## Set-up

The first `linked localize` in an app (or `linked create-package --location packages-local`)
makes these changes and prints them under `set up this app for checkouts (commit these):`

- `package.json`: `"packages-local/*"` added to `workspaces` (created if absent);
- `package.json`: `postinstall` and `dependencies` run
  `node node_modules/@_linked/cli/hooks/lock-at-rest.cjs`. An old `linked localize --relink` is
  replaced; any other existing script keeps running, with the hook appended after `&&`;
- `.gitignore`: `packages-local/` and `.packages-local.parked/`.

A second run changes nothing. It never edits `overrides`: an override key naming a package you
localize makes npm fail with `EOVERRIDE`, so localize refuses with exit 6, names the key, and
changes nothing. Remove the key and run it again.

```json
{
  "workspaces": ["packages/*", "packages-local/*"],
  "scripts": {
    "postinstall": "node node_modules/@_linked/cli/hooks/lock-at-rest.cjs",
    "dependencies": "node node_modules/@_linked/cli/hooks/lock-at-rest.cjs"
  }
}
```

**Commit the set-up with a lockfile from an install with no checkout present.** The setup itself
changes `package.json`, so after that first run `package.json` differs from HEAD and lock-at-rest
leaves the lockfile alone (it does that on purpose: see
[changing dependencies](#changing-the-apps-dependencies-while-localized)). The lockfile then
lists your checkout and must not be committed. The sequence:

```sh
npx linked localize @_linked/core   # set-up + clone + install; the lockfile now lists the checkout
npx linked delocalize               # park every checkout
npm install                         # no checkout: the lockfile gains only the set-up hunk
git add package.json package-lock.json .gitignore
git commit -m "chore: set up linked localize"
npx linked localize --parked        # take the checkouts back
```

The committed lockfile change is the root entry's `workspaces` gaining `"packages-local/*"` (and
`hasInstallScript: true` if the app had no install script before). Anyone without checkouts
installs exactly what they did before.

## Commands

| command | what it does |
|---|---|
| `linked localize <pkg…>` | set-up if needed, then per package: take back a parked checkout, else clone it; write the git hooks; one `npm install` at the app root; build each new checkout |
| `linked localize <pkg…> --adopt` | the same for a checkout already in `packages-local/`: no registry lookup, no clone |
| `linked localize --parked` | take back every parked checkout, then one `npm install`. No builds |
| `linked localize`, `linked localize --list` | each checkout (name, directory, branch, version), the parked ones, and the drift. Never writes, exits 0 |
| `linked localize --list --check` | print only the drift (on stderr) and exit 1 when there is any. What lock-at-rest runs |
| `linked delocalize [pkg…]` | park: move the checkout to `.packages-local.parked/`, then reinstall the registry copies. No names: every checkout |
| `linked delocalize <pkg…> --purge` | delete the checkout instead of parking it. Refuses on uncommitted changes or unpushed commits |
| `linked localize --relink` | deprecated, does nothing, exits 0 (old `postinstall` scripts keep working) |
| `linked localize --ensure` | deprecated, prints one hint line on stderr, exits 0 |

| option | |
|---|---|
| `--repo <git-url>` | clone this instead of the published `repository` |
| `--subdir <path>` | the package's directory inside the repository (monorepos, below) |
| `--build <cmd>` | run this in each new checkout after the install instead of the default build; `--build ""` builds nothing |
| `--dir <path>` | kept for scripts that pass it; only `packages-local` is accepted (exit 2 otherwise), because the glob and the hooks name it |
| `--adopt`, `--parked`, `--list`, `--check` | as in the table above |
| `--purge`, `--force` | `delocalize` only. `--force` deletes with `--purge` despite unsaved work |

`--adopt` takes no `--repo` or `--subdir` (exit 2): an adopted checkout is used as it is.
`--parked` takes no names. `delocalize` also accepts the part after the scope (`rdfs` for
`@_linked/rdfs`) when only one checkout matches.

**Taking a checkout back.** `linked localize <name>` moves a parked checkout back instead of
cloning, with its branch and uncommitted work as they were. A checkout that is already in
`packages-local/` is refused with exit 6 and a hint to use `--adopt`; localize never clones over a
directory.

**`--adopt`** is for a checkout that cannot come from the registry: a package you created and
have not published (`linked create-package --location packages-local` hands it to `--adopt`), or a
clone you put in `packages-local/` by hand. It expects a git checkout at the directory localize
would clone to, whose `package.json` has that name, and it never clones, pulls or fetches.

**Delocalize** parks, then reinstalls: `npm ci` when no checkout remains, otherwise `npm install`
followed by `npm rebuild <names>` (an install that replaces a link with the registry copy leaves
that package's bin without its execute bit; the rebuild restores it).

## Monorepos

If the package publishes `repository.directory` (npm's own field for this), localize clones the
whole repository into `packages-local/.repos/<checkout>` and makes `packages-local/<checkout>` a
relative link to the package inside it. `.repos` is a dot directory, which the `packages-local/*`
glob skips, so the repository root never becomes a member; npm follows the link like a directory.

If it does not, localize clones the repository, sees that the root is a different package,
removes the clone and refuses rather than link the wrong thing. Say where the package lives:

```sh
linked localize @scope/thing --repo <git-url> --subdir packages/thing
```

```
packages-local/.repos/scope-thing/                  the whole repository
packages-local/scope-thing -> .repos/scope-thing/packages/thing
```

Parking moves the link and keeps the clone. `--purge` removes the link, and the clone too when no
other checkout, here or parked, links into it.

## Building

After the install, each **new** checkout (a clone or an adopted one) is built in its own
directory: `linked build`, or `--build "<cmd>"`, or nothing with `--build ""`. A checkout taken
back from parking is not rebuilt. A failing build warns (exit 5) and the checkout stays linked:
a package whose build is broken is usually what you localized it to fix.

**The cli builds itself with `npm run build`** (its own `tsc`), not `linked build`: `linked build`
*is* the cli, and a fresh checkout of it has no `lib/` yet. It builds before the other new
checkouts, and then localize runs `npm rebuild @_linked/cli --ignore-scripts` at the app root: npm
links a bin only when its file exists, so after an install with an unbuilt cli checkout there is no
`node_modules/.bin/linked`, and `npx linked` would fetch the unrelated npm package named `linked`.

**`linked build-all`** builds the cli's own dependencies among the packages it builds first (in
dependency order), then the cli alone, then everything else. So a localized `@_linked/core` has its
`lib/` before the cli's `tsc` needs it.

**The cli and core both fresh, unbuilt checkouts.** Then `linked` itself is the unbuilt cli, and the
cli cannot build without core's `lib/`. Avoid it by localizing core first, in its own command, so
it is built by the registry cli:

```sh
npx linked localize @_linked/core   # built with the registry cli
npx linked localize @_linked/cli    # npm run build finds core's lib/
```

If both are already there unbuilt (a fresh clone of the app, say), build them by hand once,
without `linked`:

```sh
(cd packages-local/_linked-core && npm run compile)   # core's plain tsc build
(cd packages-local/_linked-cli && npm run build)
npm rebuild @_linked/cli --ignore-scripts             # link node_modules/.bin/linked
npx linked build-all                                  # everything, now with the built cli
```

Check `ls -l node_modules/.bin/linked` before the last line: without the link, `npx linked`
offers to install the npm package `linked`, which is something else.

## Drift

`linked localize --list` reports four kinds, read from npm's hidden lockfile
(`node_modules/.package-lock.json`) and the live `package.json` files:

```
@_linked/core  packages-local/_linked-core  main  2.28.3
drift: @_linked/core@2.28.3 (packages-local/_linked-core) does not satisfy dependencies "^2.28.4" of <root>
1 localized · 1 drift
```

| line | meaning | fix |
|---|---|---|
| `… does not satisfy <field> "<range>" of <importer>` | a range declared by the app, a `packages/*` member or another checkout misses the checkout's version. npm links the checkout anyway; the code that declared the range runs against a version it did not ask for | pull or bump the checkout, or the declaring package's range. Usual after a pull that bumped the app's range past your checkout |
| `second copy of localized <name>@<v> at <path>` | a registry copy of a localized package besides the checkout, usually nested because some range missed the checkout's version. It stays after the range is fixed | fix the range miss, then `rm -rf <path>` and `npm install` |
| `nested copy of <name>@<v> at <path> — the app should load one` | a nested copy of `@_linked/core`, `@_linked/react` or `@_linked/server-utils`, which must load once app-wide, localized or not | bring the nesting package's range in line with the app's, then `npm install` |
| `<dir> is installed but its checkout is gone — run npm install` | npm installed a checkout whose directory no longer exists (`npm ci` exits 0 with a dangling link) | `npm install` |

`--list --check` prints only these lines and exits 1 when there are any.

## Changing the app's dependencies while localized

lock-at-rest restores the lockfile only when `package.json` (and every `packages/*/package.json`)
matches HEAD. When you change a dependency it warns instead and leaves the lockfile, which now
lists your checkouts. `pre-commit` refuses to commit it. The way through:

```sh
npx linked delocalize               # park every checkout; npm ci
npm install some-dep                # with no checkout: a clean lockfile
git commit -am "chore(deps): some-dep"
npx linked localize --parked        # take them back
```

Version bumps of a localized package are not needed while you develop it: the app gets the
checkout whatever its version, and drift reports a range it misses.

## Pulling and switching branches

The working tree is clean, so git never refuses. After a merge or pull (`post-merge`) or a branch
switch (`post-checkout`) that changed `package.json`, `package-lock.json` or a
`packages/*/package.json`, the hooks run `npm install`, which links the checkouts again on top of
the new lockfile, and lock-at-rest restores it. A failing install is reported and never fails the
git command. A pull that rebases does not run `post-merge`; when it brought dependency changes,
run `npm install` yourself.

A `pre-commit`, `post-merge` or `post-checkout` you wrote yourself is left alone and reported;
without ours there, run `npm install` after pulls that change dependencies.

## `npm ci` with checkouts present fails

`npm ci` refuses (`EUSAGE`, lockfile out of sync): the committed lockfile does not list the
checkouts the glob now finds. Nothing is changed and the message never mentions `packages-local`.
Use `npm install` while checkouts are present; `linked delocalize` runs `npm ci` only once none
remain.

## Docker and CI

Neither has checkouts, so the glob matches nothing and `npm ci` installs the registry tree. A
Docker set-up that bind-mounts the app from the host must hide the host's checkouts, for example
with an anonymous volume over the directory:

```yaml
volumes:
  - .:/workspace
  - /workspace/packages-local     # empty: the container uses registry copies
```

The pre-commit hook can be skipped (`--no-verify`) and exists only in clones that localized, so CI
should refuse a leaked checkout entry:

```sh
if grep -nE '"packages-local/[^*]' package.json package-lock.json; then
  echo "a localized checkout leaked into the manifests"; exit 1
fi
```

## A checkout's own lockfile

A checkout is still its own repository and is released from its own lockfile. To change its
dependencies, run inside the checkout:

```sh
npm install some-dep --package-lock-only --prefix .
```

That changes only the checkout's `package.json` and `package-lock.json` and creates no
`node_modules`; without `--prefix .`, npm targets the app (the workspace root). Commit both in the
checkout, then run `npm install` at the app root to install it. A fresh clone of the checkout then
passes `npm ci`.

Some npm behaviour that comes with being a member:

- the app's `overrides` apply to the checkouts too (an app pinning `jest` runs a checkout's tests
  with that version);
- npm runs every checkout's `prepare` and `postinstall` on every root install, so keep them cheap;
- npm warns `allowScripts in workspace … is ignored` for checkouts. Harmless.

## Migrating from the old localize

The previous localize installed inside each checkout, pruned copies, symlinked by hand and
recorded checkouts in `local-packages.json`. Move every checkout in one step: a checkout still
holding its own pruned `node_modules` must not sit next to members.

1. Update `@_linked/cli` to this version.
2. Delete the record and each checkout's own install:
   `rm -rf local-packages.json packages-local/*/node_modules`. (`local-packages.json` is ignored
   now; localize prints a one-line hint while it exists.)
3. A monorepo checkout cloned whole into `packages-local/<checkout>`: move it to
   `packages-local/.repos/<checkout>` and link `packages-local/<checkout>` to the package inside
   it (`ln -s .repos/<checkout>/<subdir> packages-local/<checkout>`).
4. Remove any root `overrides` key on a package you localize (localize refuses with exit 6
   until you do) and `linked localize --ensure` from `pre*` scripts. `--relink` in `postinstall`
   is replaced by the set-up.
5. Take them all in at once: `npx linked localize <every checkout's name> --adopt`. That makes the
   set-up, runs one `npm install` and builds each checkout.
6. Commit the set-up as in [Set-up](#set-up): `npx linked delocalize`, `npm install`, commit,
   `npx linked localize --parked`.

## What it never does

- run `npm install` inside a checkout, or `npm ci` while checkouts remain
- edit `overrides`, your dependencies, a checkout's `package.json` or its lockfile
- commit anything (the set-up is reported for you to commit)
- clone over an existing directory, or overwrite a git hook it did not write
- delete a checkout with uncommitted or unpushed work (without `--force`)
- guess a repository URL

## Exit codes

| | |
|---|---|
| 0 | fine (`--relink` and `--ensure` always) |
| 1 | `--list --check` found drift |
| 2 | bad command line (`--dir` other than `packages-local`, `--adopt` with `--repo`/`--subdir`, `--parked` with names) |
| 4 | no repository could be resolved. Pass `--repo` |
| 5 | something was warned about and skipped; the rest worked (a failed build, a name that is not localized, a refused `--purge`, a failed `npm rebuild`) |
| 6 | a guard refused: an existing directory, a conflicting override, a clone that is not the package, a failed `git clone`, an unusable `package.json` |
| 7 | `npm install` (or `npm ci`) at the app root failed |

Each package is processed independently, and the exit code is the highest of the per-package codes
and the install's: a failure on the second name does not undo the first. Codes 3 and 8 belonged to
the old record file and are not reused.

## Programmatic use

```ts
import {localize, list, defaultDeps} from '@_linked/cli/localize/index.js';

const deps = defaultDeps(process.cwd());
const code = localize(['@scope/thing'], {build: 'npm run build'}, deps);
```

`localize`, `adopt`, `localizeParked`, `delocalize` and `list` are synchronous and return an exit
code from the table above. Each takes `deps` — `{appRoot, run, log, warn, error}` — so you can
point it at another directory or capture its output; `defaultDeps()` builds the usual one.
`driftProblems(appRoot)` and `describeDrift(d)` give the drift report as data.
