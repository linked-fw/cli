---
summary: >
  Step RK of CN master plan 057: `linked.kind` in every `package.json` of the CN tree (CN root,
  `packages/*`, every `packages-local/` checkout) and on a local `dev` branch of
  `linked-fw/app-template`; the old flags removed; one patch changeset per framework repo; pg-cn
  backlog item. Lands right after LK (plan 003).
status: Implementation
---

# 004 — `linked.kind` in every `package.json` (RK)

Seeded from [sub-plan 002 §RK](002-package-repos-cli-steps.md#rk--linkedkind-in-every-packagejson).
Same worktree and branches as plan 003 (`/Users/rene/web/wt/lk`, `dev--lk`).

## Mapping

- `app`: CN root, `packages/my-app`, `packages-local/semantu-webid-email`, app-template.
- `library`: CN `packages/{access,documents,maps,execution-gateway}`; `_linked-{core,react,
  server,server-utils,cli,css,icons,fuseki,s3,sentry,shape-ui,primitives,translation,auth}`.
- `ontology`: `_linked-{dcat,dcmi,org,owl,rdfs,schema,sioc,xsd}`. (`@_linked/npm` does not exist
  in this tree yet: CK creates it; CK's own landing must write `linked.kind: "ontology"` — told to
  the master in the report.)
- `packages/editor-chrome`: unmarked (no reader needs it: it has no build script and is not a
  linked package today).
- Existing `linked` objects (server, server-utils `serverOnly`) are merged into, key order kept,
  `kind` first.

## Phases

### Phase 3 — every package.json, template, changesets

- Rewrite each `package.json` with a script (JSON parse/stringify, 2-space indent, trailing
  newline, preserving key order: `linked` takes the old flag's position).
- app-template: clone `linked-fw/app-template` into the scratchpad, branch `dev` from `main`,
  commit, no push; record its path and commit in the report.
- One patch changeset per framework repo (cli and server already carry LK's minor ones).
- pg-cn backlog item (`/Users/rene/web/pg-cn/docs/backlog/`, next free number).

**Validation:** `git grep -nE '"linkedPackage"|"linkedApp"' -- '*package.json'` empty in every
repo of the tree and the template branch; no lockfile change; `planBuildAll` /
`getLincdPackages` / `discoverLinkedDependencies` over the worktree list the same packages as the
baseline taken in the main checkout before LK; CN `typecheck:gate` and
`CN_TEST_PORT=4342 npm run test:regular` green.

## Dependencies

After plan 003's phase 2. Lands right after LK, then the main-checkout rebuild and the owner's CN
check (boot log: ontology sync and shape graph sync counts, HMR package count unchanged).
