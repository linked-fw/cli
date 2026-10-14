---
'@_linked/cli': patch
---

`linked localize` now builds each new checkout with its own `npm run build` when its package.json has a `build` script, and builds nothing otherwise. Localizing an app no longer fails with "is a linkedApp, not a linkedPackage": an app's `build` script runs `linked build-app`.
