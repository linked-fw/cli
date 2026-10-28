---
summary: >
  After every @_linked/* package is republished with linked.kind, remove the retired-flag
  fallback in linkedKind (here and its server twin) and the transitional linkedPackage flag in
  this package's own package.json.
packages: [cli, server]
---

# Drop the retired-flag fallback

The release of CN plans 057/070 had to bridge two CLIs:

- The published CLI (1.57.x) builds a package only with `linkedPackage: true`, and CI and the
  publish workflow build every package with the published CLI. So this package's own
  `package.json` keeps `"linkedPackage": true` beside `"linked": {"kind": "library"}`.
- The new CLI reads `linked.kind` only, while every installed `@_linked/*` package published
  before it still says `linkedPackage: true`. So `linkedKind` reads the retired flags when
  `linked.kind` is missing (`linkedPackage` → `library`, `linkedApp` → `app`), here and in
  `@_linked/server` `src/utils/linkedDependencies.ts` (byte-identical twin).

Once every `@_linked/*` package on npm carries `linked.kind` and the published CLI reads it:

1. Remove `retiredFlagKind` and its doc paragraph from both twins, and the test case in
   `tests/unit/linkedKind.test.ts`.
2. Remove `"linkedPackage": true` from this package's `package.json`.
