---
summary: >
  The master-worktree pieces plan 003 left out (report 040): a lock on port allocation,
  `own-install`, `worktree relink --all`, `branch list`, `branch add-package`, package-only step
  worktrees, refusing a dirty owner checkout and a second copy of a package, and `land` recording
  a tested tip. Only the port lock and `own-install` (when a master changes dependencies) block
  two masters running at once; the rest are conveniences or safety nets.
source: plan 003, report 040 (Deviations, Follow-ups), 29 Oct 2026
status: open
---

# 013 — Master worktrees: what is left

Plan [003](../plans/003-master-worktrees.md) built masters in worktrees of their own
([report 040](../reports/040-master-worktrees.md)). These pieces were left out of that slice.

## Two masters at once

Running two masters side by side (each `linked branch start <m> --worktree`, each with its own
steps, preview port and dataset) works today if they are started one after the other and neither
changes dependencies. What blocks it otherwise:

- **A lock on port allocation** (blocks two masters started at the same time). `branch start
  --worktree` picks the first `45k0` slot (`MASTER_PORTS`, `src/integration/masters.ts`) that no
  master records, and records it only after creating the worktrees: two concurrent starts can pick
  the same slot. A lock around choose-and-record (a `mkdir` lock in the common git dir) closes it.
  Workaround: start masters one after the other, or pass `--port`.
- **`own-install`** (blocks a master that changes dependencies while another runs). Every master
  and step farms into the one install of the main checkout; an `npm install` for one master's new
  dependency changes what every other worktree loads. `own-install` gives a master (and its steps)
  an install of its own.

Should come with them, not blocking:

- **`worktree relink --all`**: after an `npm install` in the main checkout every worktree (two
  masters and their steps) needs `relink`; one forgotten runs against a stale farm.
- **`branch list`**: masters, integration branches and their targets in one view (`worktree list`
  shows masters today; `branch status` shows checkouts).

## Within one master

- **`branch add-package <m> <pkgs>`**: add a framework package to a running master. Today a step
  can `--with` only the master's packages, and adding one is by hand (`git -C
  <main>/packages-local/<pkg> worktree add -b <m> <wt>/packages-local/<pkg> <target>`, set
  `branch.<m>.linked-target` and `-worktree` there, `linked worktree relink` in the master and its
  steps).
- **Package-only step worktrees** (`--package-only`): a step that changes only a framework package
  gets a worktree of that package, without a full app worktree and farm.
- **Refusing a second copy**: a step that overrides a package a master package depends on runs two
  copies of it. It is warned, not refused; `doctor resolve` could flag it too.

## Safety nets

- **`branch start --worktree` refusing a dirty owner checkout**: today it starts at the last commit
  and says so (nothing is switched); `land` already refuses a dirty owner checkout.
- **`land` recording a tested tip**: today `land` stops after any merge it makes (exit 3) and a
  re-run with nothing new to merge proceeds. Recording the tip the master tested would let `land`
  refuse a tip nobody tested.

## First open question

- Does `own-install` mean a full `npm install` per master (disk, minutes), or a farm with only the
  changed dependencies installed beside it?
