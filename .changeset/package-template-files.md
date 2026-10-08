---
"@_linked/cli": patch
---

Packages created with `create-package` now publish only the files consumers need: the template's `package.json` has `"files": ["lib", "CHANGELOG.md"]`, so their tarballs no longer include `.github/`, `.changeset/`, tests or tsconfig files.
