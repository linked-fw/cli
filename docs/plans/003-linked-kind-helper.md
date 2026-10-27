---
summary: >
  Step LK of CN master plan 057: one `linkedKind(json)` helper (`@_linked/cli/installed-packages`,
  twin in `@_linked/server/utils/linkedDependencies`) replaces every `linkedPackage`/`linkedApp`
  read in the CLI, server and CN; scaffolds and both app identity stampers write `linked.kind`.
  Lands back to back with RK (plan 004).
status: Implementation
---

# 003 — `linked.kind` through one helper (LK)

Seeded from [sub-plan 002 §LK](002-package-repos-cli-steps.md#lk--linkedkind-through-one-helper)
(contracts K-kind; Files, Pitfalls, Tests there). Worktree `/Users/rene/web/wt/lk` (agent `lk`,
port 4342), branches `dev--lk` in CN, cli, server and every `_linked-*` checkout RK changes.

## Decisions

- **Helper home:** `src/installed-packages.ts` → `@_linked/cli/installed-packages`
  (`linkedKind`, `LinkedKind`, `LINKED_KINDS`; `isLinkedPackageJson` kept, defined on top of it).
- **Twin:** the server's copy in `src/utils/linkedDependencies.ts` is byte-identical between
  marker comments, each naming the other file. Chosen over a cross-repo source-text test: CI checks
  out one repo, so such a test could only run in the CN tree.
- **CN's npm fallback** (master decision in 057): `discoverLinkedDependencies` gets an optional
  third parameter `isLinked(json)` (default the server's `isLinkedPackageJson`). Only CN's
  `graphAccess.appPackagesOf` passes one, accepting `linked.kind` or `linkedPackage: true`, with
  the reason and the WU follow-up in a comment. The server itself reads only `linked.kind`.
- `shapeHierarchy.ts`'s `name.startsWith('@_linked/') ||` scope fallback: kept only if a test
  needs it (report).
- `localize/app-root.ts` field `linkedPackage` → `isPackage`.

## Phases

### Phase 1 — helper and readers (cli, server)

- cli: `linkedKind` + tests (each kind, absent, non-string, unknown string, old fields alone →
  `undefined`); switch `isLinkedPackageJson`, `lifecycle.ts` `isApp`, `cli-methods.ts` build guard
  and messages, `client-dep-includes.ts`, `shapeHierarchy.ts`, `localize/app-root.ts`,
  `createPackageLocation.ts` (`findLinkedAppRoot` → `linkedKind === 'app'`), comments in
  `vite-config.ts`, `build-package.ts`, `lifecycle.ts`.
- server: twin helper, `isLinkedPackageJson` on top of it, optional `isLinked` parameter of
  `discoverLinkedDependencies`, comments; tests switched to `linked.kind`.
- Fixtures and unit tests switched.

**Validation:** cli quick gate (sub-plan §Tests) and server quick gate green; the Verify grep finds
only registration calls and explaining comments in cli `src defaults` and server `src`.

### Phase 2 — writers, CN, docs

- `defaults/package/package.json` → `"linked": {"kind": "assets"}`; `buildPackageFiles` merges
  `kind` into an existing `linked` object; react-native template `app-shapes` → `assets`,
  `services/api` → `app`; `applyAppIdentity` drops `linkedApp`, merges `linked.kind: "app"`.
- CN: `stampAppIdentity` drops `linkedApp`, merges `linked.kind: "app"`; refuses a template whose
  kind is set and not `app`; `graphAccess.appPackagesOf` fallback; CN tests.
- Docs: CN arch-03, cli README / `docs/localize.md` / `docs/architecture/vite-runtime-config.md`,
  server `docs/architecture/01-server-only-surface.md` where they name the old fields.

**Validation:** cli `npm run test:unit`, `npm run test:template`, `npx linked build`; server full
jest + `npx linked build`; CN `npm run typecheck:gate`, the CN quick gate, and (after RK)
`CN_TEST_PORT=4342 npm run test:regular`.

## Dependencies

Phase 2 depends on 1. RK (plan 004, phase 3) runs after phase 2 on the same branches; nothing lands
before RK is ready.
