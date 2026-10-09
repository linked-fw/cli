---
'@_linked/cli': patch
---

A localized checkout's install (`linked localize`, `--relink`, `--reinstall`) now passes `--include=dev`. It runs from the app's npm lifecycle hooks, which inherit the outer command's config as `npm_config_*`, so `npm install --omit=dev` at the app root used to make the checkout skip its devDependencies and stop building.
