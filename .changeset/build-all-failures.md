---
'@_linked/cli': patch
---

`linked build-all` reports a failing package and exits non-zero. Previously, when a package's own `build` script exited non-zero, `build-all` counted the package as built, printed it under "Successfully built" and exited 0. It now prints the package's build output, lists it under "Failed to build" and exits 1, including when the failed package has no dependents or is the last one left.
