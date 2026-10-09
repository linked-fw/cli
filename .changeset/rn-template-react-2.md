---
'@_linked/cli': minor
---

`linked create-app --template react-native` now scaffolds an app on `@_linked/react` 2 and the framework releases built on it: `@_linked/react` 2.0.1 (was 1.6.4), `@_linked/schema` 1.5.0 (was 1.4.0), `@_linked/core` 2.28.1 (was 2.26.0; React 2 needs `^2.27.0`), `@_linked/server` 2.24.8, `@_linked/server-utils` 1.12.3, `@_linked/fuseki` 3.4.2, `@_linked/s3` 1.6.2 and `@_linked/cli` 1.45.6. The pins stay exact. `npm ls @_linked/react --all` in a new app shows only 2.0.1; before, `@_linked/primitives` 1.8.0 (through `@_linked/schema`) installed a second copy, 2.0.1, next to the app's 1.6.4.

A new app also has one React again. `@_linked/server` 2.24.5 and later take `react` and `react-dom` as peers, and npm resolved the peers of hoisted packages to the newest React (19.3.0) at the root, nesting the app's 19.2.3 under `apps/mobile`, so `npm run check:react` failed and `@_linked/react` loaded a different React from the app. The root `package.json` now pins `react` 19.2.3, `services/api` pins `react` next to its `react-dom`, and `apps/mobile` pins `react-dom` 19.2.3 (without it, `npm install` failed with `ERESOLVE`: `react-dom@19.3.0` wants `react@^19.3.0`).

With React 2, mounted components refetch after a mutation and identical queries share one request. The template's `nativeDefaults` test gives its loading and error cases a subject each, because the error case otherwise joined the loading case's request, which never settles. Existing apps are not changed.

Minor rather than patch: the CLI's commands do not change, but a newly generated app runs on a new major of `@_linked/react`, with its reactive refetching.
