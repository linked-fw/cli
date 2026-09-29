---
'@_linked/cli': minor
---

`build-all`: find every local package, and never skip one silently

`build-all` discovered only packages declaring `linkedPackage: true`, only inside the
`workspaces` globs, and printed nothing about anything it passed over. Measured against
Create Now, that meant `Found 3 total LINCD packages in use by this app` and `exit 0` for a
workspace of six tracked members plus 25 localized checkouts — with `@_linked/maps`, a shipped
dependency that had simply never been given the flag, dropped from a green build in silence.

Three changes:

- **Discovery is by capability, not by declaration.** `build-all` invokes each package's own
  `build` script, so any package with one is now built, flag or no flag. The flag still governs
  `linked build` and the dev resolver, and is unchanged there.
- **`packages-local/` is scanned** alongside the workspace globs. That directory is deliberately
  in no glob (`semantu localize` keeps npm from learning about the checkouts), so a walk of
  `workspaces` alone could never see it.
- **Every package found but not built is named, with the reason** — no build script, is a linked
  app, outside the repository, or not in this app's dependency tree. This alone would have
  surfaced `@_linked/maps`.

New exports from `@_linked/cli`: `discoverLocalPackages()`, which returns every local package
with the facts callers filter on (`source`, `isLinkedPackage`, `isApp`, `hasBuildScript`), and
`planBuildAll()`, which returns what would be built and what would be skipped with reasons.
`getLincdPackages()` keeps its narrow meaning — flagged packages, workspace globs only — so the
dev resolver and the runtime are unaffected; it now also honours the legacy `lincd: true`
spelling of the flag, matching `linked build-package`.

Also: user-facing output saying "LINCD packages" or suggesting `lincd build-all --from=` now says
"linked" and `linked build-all --from=`.
