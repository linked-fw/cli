---
'@_linked/cli': major
---

Remove webpack. Vite is now the only frontend build and dev server this CLI has.

**Breaking.** `linked build-app` no longer falls back to webpack when an app has no
`vite.config.{ts,js,mjs}` — it now fails with a message naming the missing file and the config to
add. `linked start --legacy` is gone (the flag started a dev server that `@_linked/server` stopped
mounting webpack-dev-middleware for, so it already served no frontend).

Removed from the public API: `generateWebpackConfig`, `DeclarationPlugin`, `externaliseModules`,
the `LinkedWebpackConfig` type and `LinkedConfig.webpack`. `buildApp` and `buildFrontend` are gone
from `@_linked/cli/cli-methods`; the equivalent is `buildViteApp` from
`@_linked/cli/commands/build-app` (or the `linked build-app` command). `assertReleaseFlagsUnused`
is replaced by `assertViteApp`. The internal webpack loaders and plugins
(`plugins/check-imports`, `plugins/watch-run`, `plugins/declaration-plugin`,
`plugins/externalise-modules`, `config-webpack`, `config-webpack-app`) are deleted, along with
every dependency that existed only to serve them: `webpack`, `webpack-bundle-analyzer`,
`webpack-license-plugin`, `webpack-manifest-plugin`, `terser-webpack-plugin`,
`copy-webpack-plugin`, `tsconfig-paths-webpack-plugin`, `@pmmmwh/react-refresh-webpack-plugin`,
`babel-loader`, `css-loader`, `postcss-loader`, `mini-css-extract-plugin`, `source-map-loader`,
`ts-loader`, `react-refresh`, `react-refresh-typescript`, `@babel/register`,
`@babel/preset-react`, `@babel/plugin-proposal-decorators` and `@babel/plugin-transform-runtime`.
(`@babel/core`, `@babel/preset-env` and `@babel/preset-typescript` stay, moved to
devDependencies — they serve this package's own Jest transform via `babel-jest`.)

**What a webpack app must do:** add a `vite.config.ts` to the app root —

```ts
import {createViteConfig} from '@_linked/cli/vite-config';

export default createViteConfig({port: 4040, cssMode: 'tailwind'});
```

— and drop any `webpack`, `cacheWebpack` or `analyse` keys from `linked.config.js`, which are no
longer read. There is no migration path that keeps webpack; pin `@_linked/cli@^1` if you need one
while you move.

`major`, because the removals above are all reachable from the package's published entry points
and from documented command behaviour. This is the first major for this package; the alternative
(a deprecation cycle) would mean shipping webpack for another release train to serve consumers
none of which were found.
