---
'@_linked/cli': patch
---

`linked localize` now builds each new checkout with its own `npm run build` when its package.json has a `build` script, and otherwise by kind: `linked build-app` for a Linked app, `linked build` for a Linked package, nothing for anything else. Localizing an app no longer fails with "is a linkedApp, not a linkedPackage".
