---
date: 2026-10-27
summary: >
  Every `package.json` of the CN tree says what it is in `linked.kind` (CN root, `packages/*`,
  the 23 `_linked-*` checkouts and `semantu-webid-email`), the old `linkedPackage` / `linkedApp`
  flags gone; a local `dev` branch of `linked-fw/app-template` does the same (not pushed). One
  changeset per framework repo; pg-cn backlog 014. Step RK of CN master plan 057, landed right
  after LK (report 032). Patch (cli and server: minor, with LK).
---

# 033 — `linked.kind` in every `package.json` (RK)

## PR

### Summary

With LK the CLI and server read only `linked.kind`; RK gives every `package.json` they read its
kind, so the owner's CN loads exactly what it loaded before. Each file was rewritten by a script
that keeps key order: `linked` takes the old flag's place, or `kind` goes first in an existing
`linked` object (server, server-utils `serverOnly`).

### Changes

- `app`: CN root, `packages/my-app`, `packages-local/semantu-webid-email`, app-template.
- `library`: CN `packages/{access,documents,maps,execution-gateway}`; `_linked-{auth,cli,core,
  css,fuseki,icons,primitives,react,s3,sentry,server,server-utils,shape-ui,translation}`.
- `ontology`: `_linked-{dcat,dcmi,npm,org,owl,rdfs,schema,sioc,xsd}` (`npm` carried both the
  kind and `linkedPackage: true` from CK; the flag is gone).
- `packages/editor-chrome`: left unmarked; it has no build script and nothing reads it as a
  linked package.
- The 14 checkouts not on `dev` (css, dcmi, icons, org, owl, rdfs, react, s3, schema, sentry,
  shape-ui, sioc, translation, xsd) joined it (`npx linked branch start dev … --target main`).
- `linked-fw/app-template`: cloned to `/Users/rene/web/app-template`, branch `dev` from `main`
  (3eb6652), commit c6b87dd: `package.json` `"linked": {"kind": "app"}`, the readme and the
  `pr.yml` comment. Not pushed; the release opens its PR.
- A changeset (`.changeset/linked-kind.md`) in each of the 23 framework repos: patch, except cli
  and server (minor, LK's).
- pg-cn: backlog 014 (`docs/backlog/014-linked-kind-in-package-json.md`), committed on pg-cn's
  local `main` (4a08b66e) through a temporary worktree; no package changes.

### Verification

- `git grep -nE '"linkedPackage"|"linkedApp"' -- '*package.json'` in CN and every
  `packages-local/` checkout, and in the template's `dev`: no output.
- No lockfile changed (`package-lock.json` records neither flag).
- `planBuildAll` / `getLincdPackages` / `discoverLinkedDependencies` over the worktree (new CLI
  and server, new `package.json`s) against the main checkout before landing (old CLI, old flags):
  identical lists (27 built, 3 skipped with the same reasons, 27 workspace linked packages, 26
  boot dependencies).
- Worktree `npx linked build-all`: `Successfully built:` 27 packages, 55 s.
- CN `npm run typecheck:gate`: `No new type errors. 0 pre-existing errors still in the baseline.`
- CN `CN_TEST_PORT=4342 npm run test:regular` on the landed tree (after Fuseki was restarted):
  `typecheck:gate PASS 16s`, `unit (vitest) PASS 60s` (`Tests 2968 passed | 5 skipped (2973)`),
  `packages PASS 6s`, `playwright (integration + sign-in e2e) FAIL 247s` — `1 failed`, `1 flaky`,
  `14 skipped`, `331 passed (4.1m)`; total 5:28. The one failure,
  `app-gateway-user-token.spec.ts:168` (`expect(lines).toHaveLength(5)` / `Received length: 1`), counts
  gateway audit lines on CN's stdout: the other four were printed unprefixed in the same instant,
  and its retry hit the first attempt's leftover dataset. Alone it passes:
  `CN_TEST_PORT=4342 npx playwright test tests/integration/app-gateway-user-token.spec.ts` →
  `7 passed (25.8s)`. Before the rebase onto CK's core the whole set passed (`336 passed`,
  `total PASS 329s`); a run in between failed on Fuseki running out of heap
  (`java.lang.OutOfMemoryError`) under concurrent test runs, not on this change.
- CN quick gate (`vitest` appTemplateIdentity, appProjectPackages, graphAccess,
  ProjectCreationOrchestrator): `Test Files 4 passed (4)` / `Tests 123 passed | 2 skipped (125)`.

### Deviations

- `@_linked/npm` was added to RK's list: CK landed it on `dev` with `linkedPackage: true` beside
  its kind.
- The worktree's link farm pointed CN's own `packages/*` at the main checkout, so the worktree's
  boot walk first lost the four `library` members; the links were pointed at the worktree by hand
  for the run (cli backlog 011).
- The template's `APP_TEMPLATE_DIR` case of `appProjectPackages.test.ts` fails against the
  current template (its `workspaces` now lists `packages-local/*` too); that is not this change
  and the case is skipped in the regular run.

### Follow-ups

- pg-cn's and the `@linked.cm/*` packages' kinds — pg-cn backlog 014.
- The release republishes every `@_linked/*` package with its kind and opens the template's PR
  from its local `dev` (CN plan 057 §Wrap-up and deployment); then the graphAccess fallback goes
  (CN plan 180 §WU).
- Worktree link farm and the app's own workspace members — cli backlog 011.

## Details

- The rewrite script parsed and re-serialised each file with two-space indent and a trailing
  newline; the diffs are the flag line and the new `linked` lines only.
- Main-checkout check after landing: see the master's report (rebuild, `curl :4040`, the CN
  backend log's ontology and shape graph sync counts).
