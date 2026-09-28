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

## Scan done, 2026-09-24 — the answer, and it is not what the question assumed

**`linked build-frontend` has zero callers.** Searched the whole workspace excluding the CLI
itself: no npm script, no CI workflow, no Dockerfile, no template. The only three mentions are
documentation, and two of them say not to use it:

- `docs/runbooks/contabo-staging-vps.md:814` — *"`linked build-frontend` is the legacy Webpack path
  and **must not be used** as an upload workaround"*
- `docs/reports/007-vite-migration.md:1390` — *"Webpack code deletion: deferred to follow-up (some
  legacy modules remain reachable via `linked build-frontend` legacy subcommands but **no longer
  used in any dev/SSR path**)"*

PeaceGame does not call it either; its scripts use `build-app`.

**But that was the wrong question.** Retiring webpack is not gated on `build-frontend` — it is
gated on `build-app`, which is live, and which *dispatches* to webpack:

```ts
// src/commands/build-app.ts:55-58
export const hasViteConfig = (appRoot = process.cwd()): boolean =>
  VITE_CONFIG_FILES.some((f) => fs.existsSync(path.join(appRoot, f)));
```

An app takes the webpack path **iff it has no `vite.config.{ts,js,mjs}`**. So the real question is
which apps lack one. Measured:

| app | `vite.config`? | path taken |
|---|---|---|
| CN itself | yes | Vite |
| PeaceGame, `feature/linked-upgrade-main-merge` | yes | Vite |
| **PeaceGame, `origin/main`** | **no** | **webpack** |
| **`packages/my-app`** | **no** | **webpack** |

**Two live consumers, and the second is the one that matters.** PeaceGame's migration is a known,
tracked piece of work that ends when its branch merges. `my-app` is not: it has no `vite.config`,
so anything built from it lands on webpack.

**And no scaffold template ships one.** None of `defaults/app-react-native`, `defaults/app-static`,
`defaults/package`, `defaults/setup-publish` contains a `vite.config`, and nothing in `src/` writes
one during scaffolding — `start.ts:87` *tells the user to write it by hand* when it is missing:

> no vite.config.{ts,js,mjs} found in … Add one: `import {createViteConfig} from '@_linked/cli/vite-config'`

So **every newly scaffolded app starts on the webpack path** and stays there until someone writes a
Vite config by hand. That is the thing to fix first, and it is cheap: emit a `vite.config.ts` from
the templates. Until then the webpack path cannot be retired, because the tool keeps creating
consumers for it.

### Revised order

1. **Make scaffolding emit a `vite.config.ts`.** Stops the population growing. Small, and
   independent of everything else.
2. **Give `packages/my-app` a Vite config**, or establish that it is a sandbox nobody builds.
3. **Wait for PeaceGame's migration branch** to merge. Not this repo's call.
4. **Then** delete the webpack path — at which point `build-frontend` can go immediately, since it
   already has no callers, and `generateWebpackConfig`'s removal from `index.ts` becomes the only
   breaking part.

Step 4's breaking-change caveat still stands: `generateWebpackConfig` is re-exported as public API,
so an external consumer could be relying on it even though nothing in this workspace is.

## Correction, same day — "every new app starts on webpack" was WRONG

I checked `packages/cli/defaults/*` and concluded that newly scaffolded apps land on webpack. That
was the wrong directory. **`create-app` does not scaffold from `defaults/`** — it shallow-clones a
GitHub repo (`cli-methods.ts:184`):

```
git clone --depth 1 https://github.com/linked-fw/app-template.git
```

**That repo already ships `vite.config.ts`.** So every app created by `create-app` is a Vite app,
and has been. No new webpack consumers are being created. The revised order in the section above —
"make scaffolding emit a vite.config first" — **is not needed and should not be done.**

What the `defaults/` templates actually are, none of which is a standalone app:

| template | what it is | needs a `vite.config`? |
|---|---|---|
| `app-static` | files copied **into an existing app** by `addCapacitor` | no — the host app has one |
| `app-react-native` | a React Native monorepo | no — RN builds with **Metro**, neither webpack nor Vite |
| `package` | a library scaffold | no — not an app |
| `setup-publish` | CI/release scaffolding | no — not an app |

### So the real consumer list is two, and shrinking

- **PeaceGame's `origin/main`** — its Vite migration is another developer's active work.
- **`packages/my-app`** — a **stale copy of the app-template**, predating the Vite migration: it
  still carries `yarn.lock`, and lacks both `vite.config.ts` and the template's `scripts/`. Note it
  cannot even run `linked start` today, which errors out without a Vite config
  (`start.ts:87`). It is not a live consumer so much as an abandoned one.

### Revised conclusion

**The webpack path can be deleted once PeaceGame's migration lands.** Nothing is creating new
consumers, CN is on Vite, and no webpack fallback is wanted. That is a much shorter runway than the
first pass suggested.

The one caveat that survives: `generateWebpackConfig` is re-exported from `src/index.ts`, so its
removal is a **breaking** change for any external consumer, even though nothing in this workspace
imports it. And `linked build-frontend` can go immediately whenever the rest does — it has no
callers at all.

Worth deciding separately: whether `packages/my-app` should be refreshed from the current template
or deleted. It is tracked (55 files) and not gitignored, so it is not scratch space, but it is
stale enough that it no longer runs.
