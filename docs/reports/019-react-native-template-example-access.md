---
date: 2026-10-19
summary: >
  The React Native template's example screen got `401 Authentication required` on every add, edit
  and delete, because `services/api` registered its `appData` store without a `withAccess` rule and
  a store with no rule needs a session for writes (backlog 016, which this report replaces). The API
  now attaches the same example rule as the web app-template: anonymous reads of `Person`, anonymous
  writes of `Person` only under `NODE_ENV=development`, a session for anything else. The template's
  integration test passes, and a new one proves a `NODE_ENV=production` API still refuses anonymous
  writes. Patch release (1.51.2). Also recorded here: the template's move to `@_linked/server` 3
  (`RemoteDataset` in its no-`url` form, `@_linked/s3` 1.6.3 so the install has one server copy),
  cli 1.48.2, during which the 401 was found.
---

# 019 — React Native template: server 3 and the example access rule

## Server 3 and `RemoteDataset` (cli#280, 1.48.2)

`@_linked/server` 3.0.0 renamed `BackendAPIStore` to `RemoteDataset` with no alias, so
`create-app --template react-native` moved:

- `apps/mobile/src/shell/storage.ts` imports `RemoteDataset` from
  `@_linked/server/shapes/quadstores/RemoteDataset` in its **no-`url` form**
  (`new RemoteDataset({name: 'appData'})`). `services/api` is the app's own backend, not a separate
  data server with a token: the API URL is resolved once in `src/shell/env.ts` and reaches `Server`
  through `SITE_ROOT`, and the no-url form sends queries through the same `Server.call` path
  (`/call/@_linked/server/<method>`). The `url` form bypasses `Server`, adds an un-awaited `ping`
  from `init()`, and is meant for a remote server that takes a bearer token.
- `apps/mobile` and `services/api` pin `@_linked/server` 3.0.0 (was 2.24.8); `services/api` pins
  `@_linked/s3` 1.6.3 (1.6.2 depended on `@_linked/server ^2.5.1` and nested a second server,
  2.25.0). `npm ls @_linked/server` in a fresh app shows only 3.0.0.
- Comments, READMEs (template and CLI), the ESLint message and `__tests__/storage.test.ts` use the
  new name.

Verified with `npm run test:template` (`Tests: 22 passed`) and a fresh generated app (Jest 24
passed, `node --test` 5 passed, typecheck, lint, `check:react`). Its integration test failed with
`Authentication required` — identically on the previous template — which is the defect below.

## Why the example access rule

`FUSEKI_PORT=<compose port> npm run test:integration` in a generated React Native app failed on
`lists 0, adds one (1), edits it, deletes it (0)` with `ServerCallError: Authentication required`.
`@_linked/server-utils`' `checkQueryAccess` gives a store with no declared rule the rule
`'session'`: an anonymous read passes with a warning until `rpcExposure` is `'enforce'`, an
anonymous mutation is refused with 401. `services/api/linked.backend.storage.ts` called
`LinkedStorage.setDefaultDataset(appData)` without `withAccess`, and the template has no sign-in.

The owner's decision: use the example access policy the web app-template
(`linked-fw/app-template`, `linked.backend.storage.ts` and `src/utils/exampleAccess.ts`) uses, so
both templates behave alike.

## What changed

All in `defaults/app-react-native/`:

- `services/api/src/exampleAccess.ts`: the app-template's `allowsAnonymousExampleWrites(nodeEnv)`
  (true only for exactly `development`; fails closed) and `exampleAccess(exampleShapes,
  anonymousWrites)` (read: a session, or only example shapes; write: a session, or anonymous writes
  allowed and only example shapes), with the same explanatory comment adapted to the mobile screen.
- `services/api/linked.backend.storage.ts`: builds the example shape set from `Person` and its super
  shapes (`getSuperShapesClasses`) and calls
  `withAccess(appData, exampleAccess(exampleShapes, allowsAnonymousExampleWrites(env.NODE_ENV)))`
  before `setDefaultDataset`, with the app-template's comment. `withAccess` is
  `@_linked/server-utils/utils/QueryAccess`, present in the pinned 1.12.3.
- `services/api/test/exampleAccess.test.mjs`: the app-template's unit tests for the rule.
- `apps/mobile/__tests__/integration/startApi.ts`: the API start (environment, detached process
  group, wait, cleanup) moved out of `globalSetup.ts` so a test can start a second API;
  `globalSetup.ts` and `globalTeardown.ts` use it.
- `apps/mobile/__tests__/integration/productionWrites.test.ts`: starts the API with
  `NODE_ENV=production` on :4101 on the same test dataset and, through the app's `RemoteDataset`,
  checks an anonymous `Person.select` passes and `Person.create`, `.update` and `.delete` are
  refused with `Authentication required` (and the create wrote nothing).
- READMEs: an Access section in `services/api/README.md`; the root test table mentions the
  production check.
- `tests/unit/createApp.reactNative.test.ts`: the new files are scaffolded, the storage file wires
  the rule, the `AWS_REGION`/`INTEGRATION_API_BIN` checks read `startApi.ts`.

## Verification

A fresh app generated by this build (`create-app rn016demo --template react-native`), against its
own Compose Fuseki on port 3041:

- `npm test`: Jest `Tests: 24 passed, 24 total`; `node --test` `# pass 10`, `# fail 0`.
- `npm run typecheck`: clean. `npm run lint`: 0 errors (5 existing `no-require-imports` warnings).
- `FUSEKI_PORT=3041 npm run test:integration`: `Test Suites: 2 passed, 2 total`,
  `Tests: 6 passed, 6 total`, including `lists 0, adds one (1), edits it, deletes it (0)` and the
  four production checks.
- The production test discriminates: with `allowsAnonymousExampleWrites` forced to `true`, the
  create and the update/delete checks fail (`Tests: 2 failed, 2 passed`).
- CLI: `npm run test:unit` `Tests: 830 passed`; `npm run build` clean.

## Notes

- A rule belongs to a store, not a shape: an admitted query can address any node in the dataset by
  id through the example shapes. Acceptable for disposable example data in development, and why
  the anonymous write stays out of production (the same caveat as the app-template).
- The template still has no production start (`./backend` is exported under `development` only);
  the production check runs `linked start --api-only` with `NODE_ENV=production`, which is what the
  rule reads.

## PRs

- https://github.com/linked-fw/cli/pull/280 (server 3, filed the 401 as backlog 016)
- https://github.com/linked-fw/cli/pull/283 (renumbered that backlog item to 016)
- https://github.com/linked-fw/cli/pull/295 (the access rule)
