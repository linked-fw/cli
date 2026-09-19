# Linked React Native monorepo

An npm-workspaces monorepo for a [Linked](https://github.com/linked-fw) app on Expo SDK 57 / React Native 0.86 /
React 19.2, with an API-only Linked backend on Fuseki.

```
apps/mobile/          Expo app (continuous native generation: ios/ is generated, not committed)
  src/shell/          env (API URL) and storage (BackendAPIStore) wiring
  src/components/     PersonOverview / PersonPreview: example add/edit/delete screen, safe to replace
  __tests__/          unit tests; __tests__/integration/ runs against a real API and Fuseki
packages/app-shapes/  Linked shapes package, consumed as TypeScript source; `linked build` for Node
services/api/         Linked backend (`linked start --api-only`), see services/api/README.md
docker-compose.yml    local Fuseki
```

## Run

Requires Node `^22.13 || >=24` and Docker. iOS builds need macOS 26.2+ and Xcode 26.4+ with the iOS platform
component installed.

```bash
npm install
cp services/api/.env.example services/api/.env   # once
npm run fuseki:up                                # Fuseki on :3030 (Docker Compose)
npm run api                                      # API-only backend on :4000
cd apps/mobile && npx expo run:ios               # generates ios/, builds a dev client, starts Metro
```

`expo-dev-client` is a dependency of `apps/mobile`, so `expo run:ios` produces a custom dev client (not Expo Go),
which is what native modules need. The app finds the API on the dev machine's host (see "API URL" below).

If port 3030 is taken, see "Port 3030 taken" in `services/api/README.md`: set `FUSEKI_PORT` in a root `.env`
and `FUSEKI_BASE_URL` in `services/api/.env`.

## Checks

| Command | What it proves |
|---|---|
| `npm run check:react` | `apps/mobile`, `@_linked/react` and `react-native` resolve one React 19.2.3 |
| `npm run typecheck` | `tsc --noEmit` in every workspace |
| `npm run lint` | ESLint over every workspace, including the `@_linked/server` subpath rule for `apps/mobile` |
| `npm test` | app Jest (shapes, render defaults, API URL) and the API's `node --test` unit tests |
| `npm run fuseki:up && npm run test:integration` | the example screen lists, adds and deletes through `BackendAPIStore` → API → Fuseki (starts its own API on :4100 with the in-memory `app-test` dataset) |
| `npm run build -w packages/app-shapes` | `linked build` emits `lib/esm` with `.js` specifiers, loadable by Node |
| `cd apps/mobile && npx expo export --platform ios --output-dir /tmp/export` | Metro resolves `@_linked/*` (including subpaths) and the workspace packages |

## Before every PR

There is no CI workflow. Run every check locally before opening or updating a PR, and paste the results into the
PR description:

```bash
npm run check:react
npm run lint
npm run typecheck
npm test
npm run fuseki:up && npm run test:integration
cd apps/mobile && npx expo export --platform ios --output-dir /tmp/export
```

## React Native specifics

- **One React.** `npm ls react` lists extra React copies nested under `@_linked/server` and
  `@_linked/server-utils`; the app never loads them, which `npm run check:react` verifies. Do not use
  `--legacy-peer-deps`: it would hide a duplicate React.
- **Workspaces are enumerated**, never globbed, so foreign repositories checked out under `packages/` are not
  adopted. `.gitignore` uses `packages/*` plus a negation per workspace package (`packages/` cannot be negated).
- **Metro** (`apps/mobile/metro.config.js`) watches the workspace root and searches both `node_modules`
  directories. It deliberately does **not** set `disableHierarchicalLookup`, which breaks npm's nested
  dependencies (e.g. `expo-asset` under `expo`). `unstable_conditionNames` covers `require()` of `@_linked/*`
  subpaths.
- **Jest** maps `@_linked/*` to its ESM build with a scoped `moduleNameMapper`. A global
  `customExportConditions` would break `@babel/runtime`. Add every workspace package to
  `transformIgnorePatterns`. The integration config restores Node's `fetch`, which jest-expo replaces with a
  stub that never sends a request.
- **Render defaults.** `@_linked/react`'s root loader and error elements are `<svg>`, which crash on React
  Native. Importing `@_linked/react/native` installs React Native defaults; `__tests__/nativeDefaults.test.tsx`
  guards it.
- **API URL.** `app.config.ts` passes `EXPO_PUBLIC_API_URL` (if set) and the API port (`defaultApiPort` in
  `src/shell/apiPort.json`, shared with `env.ts`) to `src/shell/env.ts`,
  which falls back to the dev machine's host from Expo's `hostUri`, then `localhost`, and sets
  `process.env.SITE_ROOT` and `DATA_ROOT` for `BackendAPIStore`. The app identity (name, slug, bundle id) stays in
  `app.json`.
- **Load order is enforced by imports:** `App.tsx` imports `@_linked/react/native` first, and every module that
  needs the API store imports `src/shell/storage`, which imports `src/shell/env`.
- **`@_linked/server` by subpath only** in `apps/mobile` (for example
  `@_linked/server/shapes/quadstores/BackendAPIStore`): the root barrel pulls express, webpack and react-dom.
  ESLint `no-restricted-imports` enforces it.
- **Shapes package imports are extensionless** (`./shapes/Example`, not `./shapes/Example.js`): Metro does not
  map `.js` specifiers to `.ts` source. No configuration is needed — `linked build` always adds `.js` to the
  relative specifiers in the emitted `lib/esm` JS and declarations. The app, Jest and the API in development
  consume `src/` through the `react-native` and `development` export conditions.
- **Decorators** work with the stock `babel-preset-expo`. The one custom Babel plugin,
  `apps/mobile/babel/stripJsonImportAttributes.js`, strips `with { type: 'json' }` from dynamic `import()`, which
  Metro rejects and Linked ontology packages use; `__tests__/stripJsonImportAttributes.test.ts` covers it. After
  editing `babel.config.js` or the plugin, restart with `npx expo start --clear`.
