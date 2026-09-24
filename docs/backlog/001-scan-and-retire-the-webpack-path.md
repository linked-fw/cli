---
summary: >
  The webpack build path is still wired in — two config modules, several plugins, and ~31 declared
  dependencies — but its only entry point is `linked build-frontend`, and the source already calls
  it legacy. Nobody has established whether anything still uses it. Scan, confirm, and retire it if
  not.
---

# 001 — Scan and retire the webpack build path

**Status:** open. Nothing removed; this records what is there and what has to be answered first.

## What is still wired in

Ten dependencies were dropped as provably unreferenced (see the changeset for
`chore: drop ten declared-but-unreferenced dependencies`), but that pass **deliberately left
everything webpack**, because webpack is still reachable and this needs a decision rather than a
grep.

Still present:

**Source** — `src/config-webpack.ts` (14 KB), `src/config-webpack-app.ts` (14 KB), and the
plugins built for it: `src/plugins/declaration-plugin.ts` (12 KB),
`src/plugins/externalise-modules.ts` (8 KB), `src/plugins/check-imports.ts`,
`src/plugins/watch-run.ts`.

**Dependencies** — roughly 31 of the remaining 57, once the loaders, plugins and the postcss/babel
chains that exist to serve them are counted: `webpack`, `webpack-bundle-analyzer`,
`webpack-license-plugin`, `webpack-manifest-plugin`, `@pmmmwh/react-refresh-webpack-plugin`,
`copy-webpack-plugin`, `terser-webpack-plugin`, `tsconfig-paths-webpack-plugin`, `babel-loader`,
`css-loader`, `postcss-loader`, `source-map-loader`, `ts-loader`, `mini-css-extract-plugin`,
`create-esm-loader`, plus the `@babel/*` and `postcss-*` sets.

## Why it was not simply deleted

It is still reachable, and the reachability is real rather than vestigial:

- `src/cli-methods.ts:2245` — `buildFrontend()` dynamically imports `./config-webpack-app.js` and
  runs `webpack(...)` directly
- `src/index.ts:9,11` — imports and **re-exports** `generateWebpackConfig`, so it is public API
- `src/commands/build-app.ts:80` still has a live branch reporting
  *"this app still builds with webpack and produces no release manifest"*

So `webpack` has around 20 references in source. A reference count alone cannot retire this.

## The question that decides it

**Does anything still call `linked build-frontend`, and does any app still build with webpack?**

The source already answers half of it — `cli-methods.ts:2239-2241` says outright:

> the webpack build path is legacy code, only reached by `linked build-frontend` which is not part
> of the Vite dev/SSR flow

And `build-app.ts` treats a webpack app as a recognised-but-degraded case rather than an error, which
suggests at least one was expected to exist when that was written.

Known candidate: **PeaceGame** was mid-migration from webpack to Vite and is not in this workspace.
Its state is the likeliest determinant.

## What a scan should establish

1. Which apps, if any, still invoke `linked build-frontend` or otherwise take the webpack branch.
   Check PeaceGame and anything scaffolded from `defaults/`.
2. Whether `generateWebpackConfig` has consumers outside this repo — it is exported from
   `src/index.ts`, so removing it is a **breaking** change regardless of internal use.
3. Whether `defaults/` templates still emit webpack configuration for newly scaffolded apps. If they
   do, new apps are still being created on the legacy path, and that is the thing to stop first.
4. Which of the ~31 dependencies serve *only* the webpack path, versus the Vite path too. `postcss`,
   `tailwindcss` and several `@babel/*` are shared — `@tailwindcss/vite` sits right next to
   `@tailwindcss/postcss` in the same dependency list — so this cannot be done by name matching.

## If it can go

Removing it is worth real weight: two 14 KB config modules, four plugins, and the larger half of the
dependency tree. It would also remove the `@vite-ignore` workaround at `cli-methods.ts:2244`, which
exists purely so Vite does not graph-walk into a file that is never loaded via SSR.

If it **cannot** go yet, the useful intermediate step is to mark it explicitly deprecated at the
entry points, so the next person does not have to re-derive all of the above.
