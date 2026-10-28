---
'@_linked/cli': patch
---

A `package.json` without `linked.kind` is read by the retired flags (`linkedPackage: true` is a `library`, `linkedApp: true` an `app`), so packages published before `linked.kind` still count as linked until they are republished.
