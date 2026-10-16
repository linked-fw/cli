---
'@_linked/cli': patch
---

The linked package sort no longer counts devDependencies, so `@_linked/core` (which has the cli as a devDependency) and `@_linked/cli` are no longer read as a cycle, and "Could not sort lincd packages, circular dependencies?" is no longer printed for them.
