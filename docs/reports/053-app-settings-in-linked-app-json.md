---
date: 2026-11-10
summary: >
  `linked.app.json` holds every setting of an app (`cssMode`, `syncShapesOnBoot`,
  `datasetCloneScript`, `publish`, `server`); `linked.config.js` is no longer read and an app that
  still has one is refused with the JSON to move it into. `LINKED_RPC_EXPOSURE` wins over
  `server.rpcExposure`. `defineConfig` and the old webpack types are gone. `generate-ontology`
  also replaces an import of a register module deleted by hand. Major.
packages: [cli]
---

# 053 — An app's settings in `linked.app.json`

## PR

### Summary

**Settings.** Schema version 1 of `linked.app.json` (still `schemaVersion: 1`: nothing of it is
released) gains every declarative field the old `linked.config.js` had:

| Key | Values | Read by |
|---|---|---|
| `cssMode` | `tailwind` \| `postcss` | `LinkedServer` (server-side rendering in development) |
| `syncShapesOnBoot` | boolean | `LinkedServer` |
| `datasetCloneScript` | string | `linked worktree add --dataset`, `linked branch start --worktree --dataset` |
| `publish.staticAssets`, `publish.releasePrefix` | string list, string | `linked build-app` |
| `server.rpcExposure` | `warn` \| `enforce` | `LinkedServer` |
| `server.rawQueries` | `off` \| `session` | `LinkedServer` |
| `server.apiOnly` | boolean | `linked start`, `LinkedServer` |
| `server.cachePaths`, `server.cacheTimeout` | string list, milliseconds | `LinkedServer` |

Each is checked (an unknown key is refused, inside `server` and `publish` too) and written back in
the schema's order, so `linked prefixes` keeps them. The cli builds `LinkedServer`'s configuration
from the file (`linkedServerConfig(appRoot, env)`) in `linked start`, in a compiled server
(`startServer`, so `serve-app`) and in `linked run --spawn`, and adds the load hooks itself.

**`linked.config.js` is refused.** An app with `linked.config.js` or `lincd.config.js` fails at
server start and at `build-app` with:

```
<app>/linked.config.js is no longer read: an app's settings live in linked.app.json. Move them there and delete linked.config.js:

  {
    "$schema": "https://linked.cm/schema/app/1.json",
    "schemaVersion": 1,
    "prefixes": {},
    "cssMode": "tailwind",
    …
  }

Keep only the keys you set. Values are JSON: a value computed from the environment becomes the variable (LINKED_RPC_EXPOSURE wins over "server.rpcExposure"). `webpack` and `server.multiCore` are gone; `server.loadAppComponent` and `server.loadRoutes` are not settings (the server loads src/App and src/routes). Run `linked prefixes` to fill "prefixes".
```

`worktree add --dataset` only prints a hint, so it falls back to the default script instead of
failing.

**`LINKED_RPC_EXPOSURE`** (when set) wins over `server.rpcExposure`, so an app that pins `enforce`
in the file can still be switched to `warn` for a diagnosis without editing it; any other value
is refused at start (a typo must not fall back to the server's default, `warn`).

**Removed.** `defineConfig` (nothing reads a settings module any more), the old webpack build's
`ModuleConfig` / `AdjustedModuleConfig`, `LinkedServerConfig.multiCore` (read nowhere),
`resolveLinkedConfigPath` / `LINKED_CONFIG_FILES`.

**Generator fix.** `linked generate-ontology` replaces a side-effect import of a
`src/ontologies/<name>.register.js` whose module no longer exists (deleted by hand) with the
import of `./ontologies/index.js`, as it does for register modules it removes itself. An import of
a register module that exists is left.

**App template.** The template repository's branch `linked-app-json` (commit 217243e) moves its
`cssMode` into `linked.app.json`, deletes `linked.config.js` and updates its readme; it merges
with this major's release (backlog 018).

### Changes

- `src/utils/appConfig.ts`: settings in `AppConfig`, checks, `serializeAppConfig` writes them,
  `LEGACY_CONFIG_FILES`, `assertNoLegacyConfig`, `readAppSettings`, `linkedServerConfig`.
- `schema/app/1.json`: the new keys.
- `src/interfaces.ts`: `AppServerSettings`, `CssMode`, `RpcExposureMode`, `RawQueriesMode`;
  `LinkedConfig` / `LinkedServerConfig` as the server configuration; webpack types removed.
  `src/defineConfig.ts` removed; `src/index.ts` exports.
- `src/commands/start.ts`, `src/cli-methods.ts` (`startServer`, `runMethod`),
  `src/commands/build-app.ts`, `src/commands/worktree.ts`, `src/cli.ts`: read `linked.app.json`.
- `src/utils/generateOntology.ts`: the register-import fix.
- README (`linked.app.json` table, release and API-only sections), `docs/integration-branches-and-worktrees.md`.
- Tests: `appConfig.test.ts` (settings read, refused, written back; legacy file refused; server
  configuration and the environment; `linked prefixes` keeps settings), `datasetCloneHint.test.ts`,
  `startApiOnly.test.ts`, `ontologyGenerator.test.ts` (the register import).
- Changeset `.changeset/app-settings-in-linked-app-json.md` (major); backlog 018 item 2.

### Verification

- `node lib/esm/launch.js build` → `✔ Build successful` (6.0 s).
- `npx jest tests/unit` → `Test Suites: 105 passed, 105 total`, `Tests: 1312 passed, 1312 total`
  (1 min 36 s).
- `npm run test:e2e`, with the clone in `create-app` pointed for the run at the template branch
  (`git clone --depth 1 --branch linked-app-json file://…/app-template`, reverted and rebuilt
  after) → `7 passed (1.5m)`.
- An app folder with only `package.json` and `linked.config.js`, `linked start` → `Error: …/linked.config.js is no
  longer read: an app's settings live in linked.app.json. Move them there and delete linked.config.js:` and the JSON above.
- A host app on this cli, its settings moved into `linked.app.json` (`cssMode`, `syncShapesOnBoot:
  false`, `server.rpcExposure: "enforce"`, `server.rawQueries: "off"`), started on its own port:
  signed in; its server-rendered page carries `tailwindcss v4.3.3`; `/api/select-raw` answers
  `403` anonymous and signed in; started with `LINKED_RPC_EXPOSURE=warn` it logs
  `!! RPC EXPOSURE IS 'warn', NOT 'enforce'.` (none without the variable); its integration and unit
  suites pass (424 passed, 4525 passed).

### Deviations

- The e2e clones the template's `main`, which still has `linked.config.js` until the release: it
  was run against the template branch with an uncommitted change (above). Against `main` it fails
  until the branch merges (backlog 018 item 2).
- The template is a separate repository: its change is a pushed branch, no PR (it merges with the
  release).

### Follow-ups

- Merge the template branch with the release; host apps that write a `linked.config.js` into the
  apps they create switch first: backlog 018 item 2.
- Schema URL, core range, hyphenated prefixes: backlog 018 (unchanged).

## Details

### Decisions taken autonomously

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| 1 | scope | Which fields of the old config move | Every declarative one in use: `cssMode`, `syncShapesOnBoot`, `datasetCloneScript`, `publish`, `server.rpcExposure`, `rawQueries`, `apiOnly`, `cachePaths`, `cacheTimeout` | Only the four named | They are all still read; leaving any out loses it silently |
| 2 | scope | `server.loadAppComponent`, `loadRoutes` (functions), `server.multiCore` (read nowhere), `webpack` | Not settings: the cli always sets the hooks; `multiCore` and the webpack types removed; the refusal names them | Keep a code escape hatch | No app overrides the hooks; one way |
| 3 | env | `LINKED_RPC_EXPOSURE` vs the file | The variable wins when set; an invalid value is refused | The server's order (config wins) | Keeps the break-glass switch working for an app that pins `enforce` in its file; a typo must not open methods |
| 4 | env | `LINKED_RAW_QUERIES` vs the file | The file wins (the server's order) | The variable wins too | Only the RPC switch has a diagnosing use; a variable must not reopen raw queries an app turned off |
| 5 | API | `defineConfig` | Removed | Keep for typing | Nothing imports a settings module any more |
| 6 | legacy | `lincd.config.js` | Refused like `linked.config.js` | Ignore it | Its settings would be lost silently |
| 7 | worktree hint | A leftover config or invalid file when printing the clone hint | Falls back to the default script | Fail `worktree add` | The hint is advice; the server start refuses the app anyway |
| 8 | template | The template is its own repository | Branch `linked-app-json`, merged with the release | Merge now | The published cli does not read the settings yet |
| 9 | generator | Which imports of a missing module to replace | Only `src/ontologies/<name>.register` with no source file | Any import of a missing file | The case found; anything wider could hide a real broken import |

### Phases

1. Settings in `linked.app.json`, refusal, environment, readers, types, README, tests — build and
   1312 unit tests pass.
2. Generator register-import fix — its unit test passes.
3. Template branch, e2e against it — 7 passed.
