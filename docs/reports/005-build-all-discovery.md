---
summary: >
  `build-all` reported success over a third of the workspace — 3 packages discovered where 31
  exist — and said nothing about the 28 it passed over. Records why the discovery key was wrong
  in principle (`build-all` never calls `linked build`, so `linkedPackage: true` was never the
  relevant fact), why silence rather than the narrow scan was the real defect, the invariant a
  test now pins, and the retraction of a proposed fix that rested on a package-level
  `linked.config` that does not exist.
---

# `build-all` discovered three packages out of thirty-one

`4a1d419`, PR [#154](https://github.com/linked-fw/cli/pull/154), released in **1.27.0**.

`linked build-all` is the command this package offers as the answer to *does the workspace
compile*. Against the Create Now workspace — six tracked members plus 25 localized checkouts —
it printed

```
Found 3 total LINCD packages in use by this app
```

and exited 0. Among the 28 it did not mention was `@_linked/maps`, a **shipped dependency** that
had simply never been given the `linkedPackage: true` flag.

The principle the commit body states is the whole justification for the change:

> A green result covering half the workspace is worse than a red one, because people act on it.

## Three independent narrowings, and which one was the defect

1. **A declaration filter** — only packages with `linkedPackage: true` were considered.
2. **A glob-only walk** — only the root `workspaces` field was crawled, and `packages-local/` is
   deliberately in no glob. That is not an oversight in the localize design; keeping npm ignorant
   of those checkouts is the point of it (see [report 007](007-localize-command.md)). But it meant
   the build tool could not see the packages a developer was actively working on.
3. **Silence** — nothing was printed about anything passed over, and the exit code was 0.

(1) and (2) are scope bugs; each alone is survivable, and each would have been noticed eventually.
**(3) is the defect.** It is what made the other two invisible and what let a green
`build-all` stand in for evidence. The fix widened the scan, but the part worth keeping is that
every package found is now accounted for out loud.

## The key was wrong in principle, not merely too narrow

`build-all` **never calls `linked build`.** It runs each package's own `build` script through a
per-package-detected package manager. `linked build`'s `linkedPackage: true` precondition
therefore never applied to it: the flag says *this package participates in the linked module
graph*, which is meaningful to `linked build` and to the dev resolver and says nothing whatever
about whether the package can be compiled.

From `planBuildAll`'s doc comment:

> What counts as buildable is a CAPABILITY, not a declaration: `build-all` invokes each package's
> own `build` script, so anything with one can be built whether or not it carries the flag.

`hasBuildScript` is checkable. `linkedPackage: true` is a claim someone remembered to write. Had
the key been the capability from the start, `@_linked/maps` would have been built without anyone
noticing the flag was missing.

`getLincdPackages()` survives with its narrow, workspace-and-flag meaning, but is now expressed as
a filter over the new walk rather than a second copy of it — so the two can no longer disagree
about what exists.

## What discovery does now

`discoverLocalPackages()` in `src/lifecycle.ts` does **one** walk over **two** sources, tagging
each result with `source: 'workspace' | 'local-packages-dir'`:

- the `workspaces` globs, with npm-compatible negation handling and recursion into nested
  workspaces;
- every immediate subdirectory of `packages-local/` holding a `package.json`, dot-dirs skipped.

Results are **de-duplicated by realpath** — a checkout reachable both ways would otherwise be
built twice and counted twice, which is the same class of error as not counting it at all.

Discovery **filters nothing**. It records `source`, `isLinkedPackage`, `isApp`, `hasBuildScript`
and leaves every decision to callers. `planBuildAll()` then returns `{build, skipped}`, where each
skip carries a reason:

```
Found 27 linked packages to build: …
Skipping 4 packages found but not built:
  - @create-now/editor-chrome: has no `build` script
  - lincd.org: not in @semantu/create-now's dependency tree
  - localpkg: has no `build` script
  - my-app: is a linked app — build it with `linked build-app`
```

Note what the reasons reveal. Some exclusions are correct — an app is not a library; a
deliberately build-free package has no build script. Before this change those were
indistinguishable from the two dozen wrong exclusions, because none of them were mentioned at all.

The dependency-tree filter was kept rather than dropped. Measured: with `packages-local/` in
scope it excludes exactly **one** package, an April checkout, and that exclusion is now printed.

## The invariant

`tests/unit/buildAllDiscovery.test.ts` pins **`built + skipped == discovered`**. Every discovered
package must land in exactly one bucket. That is the assertion that makes the silence
unrepeatable: a future narrowing can still be wrong, but it can no longer be quiet.

Six cases: finds `packages-local` checkouts no glob covers; records facts rather than filtering;
`getLincdPackages` keeps its narrow meaning; builds an unflagged package that has a build script;
names every package found but not built, with a reason; builds everything with a build script when
there is no app root.

## Naming

Printed strings moved from `LINCD` to `linked`, including help text that named
`lincd build-all --from=` — a command that no longer exists. Deliberately left alone:
`registry.lincd.org` messages and the `--uri-base` help, which reference a **real domain**. A
rename sweep that also rewrites hostnames produces messages that are wrong in a way nobody
notices until a URL is copied out of them.

## Retraction: the fix that was proposed first

The change was originally scoped as *key on `linkedPackage: true` **or** the presence of a
`linked.config` file in the package*. That rests on a premise that does not exist.

There is **no package-level `linked.config`**. Every reference in this repository is to an
**app** config, read from the app root:

```
src/cli-methods.ts:1986   await import(path.join(process.cwd(), 'linked.config.js'))
src/cli-methods.ts:2098   await import(path.join(process.cwd(), 'linked.config.js'))
src/commands/build-app.ts:81    ['linked.config.js', 'lincd.config.js']
src/commands/start.ts:41        LINKED_CONFIG_FILES = ['linked.config.js', 'lincd.config.js']
```

`src/utils.ts:633` carries a `@TODO` asking whether packages should also be able to use one, which
is the closest thing to evidence for the premise and is in fact evidence against it. Keying
discovery on that file would have discovered nothing new, while appearing to widen the scan.

The general shape of the mistake is worth more than the instance: **a proposed key should be
checked against the filesystem before it is implemented**, because a key that matches nothing
behaves exactly like a key that is merely conservative.

## A related retraction, recorded here because [report 004](004-webpack-retired.md) predates it

Report 004 documents the webpack retirement but not how badly the backlog item that scoped it
understated the job. Re-measured at the time of the removal:

| The backlog said | Measured |
|---|---|
| 5 source files mention webpack | **15**, and the largest — `config-webpack-app.ts`, 432 lines — was missing from the list entirely |
| 17 dependencies to drop | **20**, once the loaders were counted |
| "one re-export and one consumer" | 2014 deleted lines across 22 files |

Three of the four claims held; the *size* did not, by roughly fourfold. A handover document's
inventory is a starting point for a scan, never a substitute for one — and the item that is missed
is characteristically the biggest file, because whoever wrote the list was reading imports rather
than grepping.

## Known unverified

`vite-config.ts` keys source-package discovery on `linkedPackage !== true`, so adding the flag to a
package moves a consuming dev server to resolve it through the workspace-TS resolver rather than
its `development → ./src/*.ts` export condition. Both serve the same `src/` and the difference
should be nil, but no dev server was booted to confirm it.
