# api

The Linked backend: `@_linked/server` in API-only mode (`linked start --api-only`), with no web frontend. The
mobile app's `BackendAPIStore` sends DSL queries here; the generic `BackendAPIStoreProvider` forwards them to
Fuseki. Shapes come from `app-shapes`, which Vite loads from source in development.

## Run

```sh
cp services/api/.env.example services/api/.env   # once
npm run fuseki:up                                # from the repo root; Docker Compose Fuseki on :3030
npm run api                                      # API on :4000; GET / is 404 by design
```

`npm run api` checks that Fuseki answers first and exits with "Run `npm run fuseki:up`" if it does not.

**Port 3030 taken** (for example by another project's Fuseki): pick another host port in two places.
1. A root `.env` (gitignored; Docker Compose reads it automatically): `FUSEKI_PORT=3031`.
2. `services/api/.env`: `FUSEKI_BASE_URL=http://localhost:3031`.

The integration tests read `FUSEKI_BASE_URL`, or `FUSEKI_PORT`, from the shell environment
(`FUSEKI_PORT=3031 npm run test:integration`), then from `services/api/.env`. They refuse to reset anything unless
that port is the one Docker Compose publishes for this repo's `fuseki` service.

## Backend export

`package.json` exports `./backend` under the `development` condition only (`src/backend.ts`), which is what
`linked start` uses. A production start is not set up yet.

## Storage

- **Graph:** `linked.backend.datasets.json` configures the `appData` Fuseki store. `FUSEKI_DATASET` picks the
  dataset (`app-dev`) and `FUSEKI_DB_TYPE` its type (`tdb2`, or `mem` for tests); it is created on startup.
  The integration tests use the in-memory `app-test` dataset and reset it on every run.
- **Files:** a `LocalFileStore` in `services/api/data/uploads/` by default (the path is relative to the working
  directory, which is `services/api` under `npm run api`). When all of `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_ENDPOINT` and `S3_FILES_BUCKET_NAME` are set, an `S3FileStore`
  (S3, or an S3-compatible service such as DigitalOcean Spaces) is used instead. The S3 branch is not yet verified against a real bucket.

## Dependencies

`react` and `react-dom` are direct dependencies although the API renders no pages: `LinkedServer` imports
`react-dom/server` at load time, and `@_linked/server` takes both as peers. They are pinned to the React that
`apps/mobile` uses (19.2.3), so npm installs one copy of each at the root instead of the newest release.

`linked start` finds the hoisted `app-shapes` workspace and runs in workspace mode: Vite loads `app-shapes` from
`src` through its `development` export condition, while published packages such as `@_linked/core` and
`@_linked/fuseki` stay external, so the stores `loadStores` imports share one core instance.

## Test

`npm test -w services/api` runs the unit tests with `node --test`.
