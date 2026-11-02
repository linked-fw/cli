---
'@_linked/cli': patch
---

`linked checkout` ignores `branch` keys on the app's default branch (with a message per key), and `linked branch merge` refuses a key naming the merged branch when no checkout of that package is on it.
