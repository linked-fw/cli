---
'@_linked/cli': patch
---

The Node CSS loader now names package stylesheets in the mode the app actually runs in. It runs on Node's module-hooks thread, which copies `process.env` when `launch.js` registers it, before the CLI loads the app's `.env`. So a `NODE_ENV=development` that came only from `.env` (or `.env-cmdrc.json`) never reached it, and externalised packages such as `@_linked/primitives` were server-rendered with production class names while the dev client used dev names, which caused a hydration mismatch. `launch.js` now resolves the mode before registering the hooks (shell, then `.env`, then the `.env-cmdrc.json` profile, then `development` for `linked start`) and passes it to the loader through `register(url, {data})`. Production naming is unchanged.
