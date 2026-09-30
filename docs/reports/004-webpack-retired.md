---
summary: Webpack is gone from @_linked/cli — the build-app fallback, both config modules, four
  plugins, the `--legacy` dev server and 20 dependencies. Records who was measured to be on the
  webpack path (one app, fixed), what the removal breaks for consumers, and the postcss set that
  is now unreferenced but was deliberately left in place.
---

# Webpack retired

Closes `docs/backlog/001-scan-and-retire-the-webpack-path.md`, which asked four questions before
anything could be deleted. All four were answered by measurement, and the answer to each was
"nothing depends on it".

## What the scan found

**Does any app still build with webpack?** `linked build-app` dispatched on `hasViteConfig()`, so
the question is "which app roots have no `vite.config.{ts,js,mjs}`". Across the create-now
workspace — the only workspace where this CLI is consumed locally — exactly one did:
`packages/my-app`, a drifted copy of `linked-fw/app-template`. It was given the template's
`vite.config.ts` as part of this change, so the webpack path had no consumer left when it was
deleted. `linked-fw/app-template`, which `linked create-app` clones, ships `vite.config.ts`
already, so nothing was creating new webpack apps. `defaults/app-react-native` is Expo/Metro and
`defaults/app-static` is a Capacitor overlay; neither emits webpack configuration.

**Does `generateWebpackConfig` have consumers?** It was re-exported from `src/index.ts`, so it was
public API. No importer was found anywhere in the create-now workspace, including the 25 local
framework checkouts under `packages-local/`. External consumers cannot be ruled out from here —
hence `major` rather than a patch.

**`linked build-frontend`** was already gone; only `buildApp`/`buildFrontend` in `cli-methods.ts`
still reached the webpack config, and `@_linked/server` had already removed the
webpack-dev-middleware branch that `linked start --legacy` depended on. That flag therefore
started a dev server which served no frontend at all, and it was removed with the rest.

**Which of the ~31 dependencies serve only webpack?** Twenty, listed in the changeset. Three
`@babel/*` packages (`core`, `preset-env`, `preset-typescript`) are kept because `babel-jest`
drives this package's own Jest transform with them; they moved from `dependencies` to
`devDependencies`. `babel.config.cjs` at the repo root was deleted: both Jest configs set
`configFile: false, babelrc: false`, so it was read by nothing but `babel-loader`.

## What replaced the fallback

`assertReleaseFlagsUnused` existed because a webpack app could be built but not released, so the
release flags had to be refused on that path. It is replaced by `assertViteApp`, which refuses the
*app*: a root with no Vite config now fails `linked build-app` with the file it is missing and the
three lines to put in it.

## Left behind, deliberately

`postcss`, `postcss-import`, `postcss-nested`, `postcss-preset-env`, `postcss-url` and
`@tailwindcss/postcss` have **zero references in `src/`** after this change — they served the
`postcss-loader` chain in `config-webpack.ts`. They were not removed: an app's own PostCSS config
may name them and resolve them through this package, which is an accidental dependency rather than
a contract but would break silently. Removing them is a separate, measurable change.

`@_linked/server` still declares `webpack`, `webpack-dev-middleware` and `webpack-hot-middleware`
while its only remaining references are in comments and in tests that assert the *legacy manifest
shape* is still read. That is a separate repository and was not touched.
