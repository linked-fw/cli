---
date: 2026-11-12
summary: >
  New `linked.kind` `tooling`: built by `linked build` like a library, but not a linked package, so
  `isLinkedPackageJson` (boot loading, dev resolver, Vite exclusion, installed-package discovery,
  host imports and listings) leaves it out. `isBuiltByLinkedBuild` covers what `linked build`
  accepts. The CLI declares itself `tooling`. Minor.
packages: [cli]
---

# 055 — The `tooling` package kind

## Summary

The CLI declared `"linked": {"kind": "library"}` only so that `linked build` would build it. That
made it a linked package to every consumer of `isLinkedPackageJson`: hosts imported it into their
package listings and datasets although it carries no shapes, ontology or components. It is a dev
tool.

`LinkedKind` gains `tooling`. `isLinkedPackageJson` is now an explicit allow-list (`ontology`,
`assets`, `library`) instead of "any kind but `app`", so `tooling` is not a linked package.
`isLinkedPackageKind(kind)` (with the type `LinkedPackageKind`) is the same test for a caller
that holds a kind already read, such as one stored in a record or stated by a registry manifest.
`isBuiltByLinkedBuild` (linked package or `tooling`) is what `linked build` and the editor-hook
`build-package` accept. `build-all` was already capability-based (any package with a `build`
script), so it still builds the CLI first.

## PR

**What changed**

- `src/installed-packages.ts`: `tooling` in `LinkedKind` / `LINKED_KINDS`; `isLinkedPackageJson`
  true only for `ontology`, `assets`, `library`; new `isLinkedPackageKind`, `LinkedPackageKind`
  and `isBuiltByLinkedBuild`.
- `src/cli-methods.ts` (`linked build` guard) and `src/commands/build-package.ts`: accept
  `tooling` through `isBuiltByLinkedBuild`; the refusal message names `tooling`.
- `src/lifecycle.ts`: doc comment of `LocalPackage.isLinkedPackage`.
- `package.json`: `"linked": {"kind": "tooling"}`.
- `README.md` §Package kinds.
- Tests: `tests/unit/linkedKind.test.ts` (tooling is not a linked package, nor its kind; it is built by
  `linked build`, the CLI's own `package.json` is tooling);
  `tests/unit/installedLinkedPackagesTooling.test.ts` (`discoverInstalledLinkedPackages` skips a
  tooling dependency).

**Verification**

- `npx jest --config jest.config.cjs`: 104 of 106 suites passed on the first run; the other two
  (`ontologyDataReachable`, `shapeHierarchy`) need the built CLI and failed only because the
  worktree had no `lib/` yet. After `npm run build`, they pass:
  `Tests: 40 passed, 40 total` (those two plus `linkedKind`).
- `npm run build`: clean.

**Follow-ups**

- `@_linked/server`'s `utils/linkedDependencies` holds a byte-identical twin of `linkedKind`. It
  does not know `tooling` yet, so it reads the CLI's kind as undefined, which already excludes it
  from what the server loads. The twin should gain `tooling` (and the allow-list) at its next
  change to stay byte-identical.

## Details

- Every other consumer of `isLinkedPackageJson` (client-dep-includes, vite-config, utils,
  shapeHierarchy, `getLincdPackages`) means "carries shapes/ontology/components", so excluding
  `tooling` there is the intended effect.
- Other local framework checkouts were surveyed: no other one is a build or dev tool. `@_linked/css`
  (CSS only) and `@_linked/icons` (icon re-exports) carry no `src/package.ts`, but they ship to
  the browser as runtime libraries, so they stay `library`.
