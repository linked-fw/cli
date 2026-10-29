---
summary: >
  The master-worktree pieces still left after report 041: `own-install` (a master that changes
  dependencies while another runs), package-only step worktrees, refusing a second copy of a
  package, and two safety nets (`branch start --worktree` refusing a dirty owner checkout, `land`
  recording a tested tip). Only `own-install` blocks two masters running at once.
source: plan 003, report 040 (Deviations, Follow-ups), report 041, 29 Oct 2026
status: open
---

# 013 — Master worktrees: what is left

Plan [003](../plans/003-master-worktrees.md) built masters in worktrees of their own
([report 040](../reports/040-master-worktrees.md)); [report 041](../reports/041-master-worktrees-part-one.md)
added the machine-wide port lock and registry, `worktree relink --all`, `branch list` and
`branch add-package`. These pieces are still left out.

## Two masters at once

Two masters started at once (in one app or two) get different preview ports, and one command
relinks every worktree after an install. What still blocks running them side by side:

- **`own-install`** (blocks a master that changes dependencies while another runs). Every master
  and step farms into the one install of the main checkout; an `npm install` for one master's new
  dependency changes what every other worktree loads. `own-install` gives a master (and its steps)
  an install of its own.

## Within one master

- **Package-only step worktrees** (`--package-only`): a step that changes only a framework package
  gets a worktree of that package, without a full app worktree and farm.
- **Refusing a second copy**: a step that overrides a package a master package depends on runs two
  copies of it. It is warned, not refused; `doctor resolve` could flag it too.

- **Building the CLI in a fresh worktree**: in a master's or step's `packages-local/_linked-cli`
  that has no `lib/` yet, `npx linked build` fails (`sh: linked: command not found`): the
  worktree's farm links `.bin/linked` to that same unbuilt CLI. The first build there runs the main
  checkout's bin (`<main>/node_modules/.bin/linked build`); `worktree add`/`branch start` could
  print that, or fall back to it.
- **`worktree remove <agent>` does not find a master's step by its agent name** (step SY of CN
  plan 282). Run from the app's main checkout:
  `npx linked worktree remove sy` →
  ``No worktree of /Users/rene/web/create_now for sy: none on dev--sy, nor at /Users/rene/web/wt/sy.
  Pass its directory with --dir; `linked worktree list` shows the worktrees.``
  while `linked worktree list` showed `step sy  /Users/rene/web/wt/hub-imports--sy`. It worked with
  `npx linked worktree remove sy --dir /Users/rene/web/wt/hub-imports--sy` (and then kept the landed
  `hub-imports--sy` branches: `@_linked/core: kept hub-imports--sy (not dev--sy).`). `remove` should
  look up `<m>--<agent>` steps as `list` does.
- **A step with its own framework package loads two copies of it.** The link farm points CN's
  `@_linked/core` at the step's checkout, while the main install's other `@_linked/*` packages
  (`@_linked/fuseki`, `@_linked/access`, …) resolve core from the main checkout. CN's
  `npm run typecheck:gate` in step SY's worktree reported 117 errors, every one between
  `…/hub-imports--sy/packages-local/_linked-core/…` and `…/create_now/packages-local/_linked-core/…`
  types (e.g. `FusekiStore` not assignable to `IDataset`); with `paths` mapping `@_linked/core` to
  the step's build, `tsc` gave 0 errors. The farm could link every package that depends on a
  `--with` package so it resolves the step's copy, or `worktree add` could print the `paths`
  override for typechecks.

## Safety nets

- **`branch start --worktree` refusing a dirty owner checkout**: today it starts at the last commit
  and says so (nothing is switched); `land` already refuses a dirty owner checkout.
- **`land` recording a tested tip**: today `land` stops after any merge it makes (exit 3) and a
  re-run with nothing new to merge proceeds. Recording the tip the master tested would let `land`
  refuse a tip nobody tested.

## First open question

- Does `own-install` mean a full `npm install` per master (disk, minutes), or a farm with only the
  changed dependencies installed beside it?
