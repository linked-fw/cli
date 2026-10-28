---
summary: In an agent worktree the link farm points the app's own workspace members (CN's `packages/*`) at the main checkout, so a change to one of their `package.json` files is invisible to the worktree's server, build-all and tests. Found when step RK changed `linked.kind` in CN's `packages/*`.
source: CN master plan 057, steps LK and RK (cli reports 032, 033), 27 Oct 2026
---

# Worktree: the app's own workspace members link to the main checkout

## Problem

`linked worktree add` links `node_modules/<name>` of the app's own workspace members
(`packages/access`, `packages/maps`, `my-app`, …) to the main checkout's entries, which resolve
to the main checkout's `packages/<name>`. Report 031 lists it under Limitations. When a worktree
changes one of those directories, the worktree's CN, `build-all` and `discoverLinkedDependencies`
read the main checkout's copy instead.

Seen in step RK: the worktree's `packages/{access,documents,maps,execution-gateway}` had
`linked.kind`, the main checkout's still had `linkedPackage: true`, and the worktree's boot walk
lost all four until the links were pointed at the worktree by hand
(`ln -sfn <worktree>/packages/<name> node_modules/@_linked/<name>`).

## First open questions

- Link workspace members to the worktree's own directories always, or only when they differ from
  the main checkout's (their build lives in `lib/`, which a fresh worktree lacks: `build-all`
  builds it)?
- Should `relink` do the same for an existing farm?
