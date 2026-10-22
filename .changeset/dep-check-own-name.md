---
'@_linked/cli': patch
---

The build's dependency check no longer reports a package's own name (imported from its tests, for example) as a missing dependency.
