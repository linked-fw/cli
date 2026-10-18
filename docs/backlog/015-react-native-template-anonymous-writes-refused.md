---
summary: >
  The React Native template's example screen cannot add, edit or delete a Person: the API refuses
  every anonymous mutation on the generic query plane with 401 "Authentication required", because
  `services/api` registers its `appData` store without a `withAccess` rule and a store with no rule
  requires a session for writes. The template's integration test fails on this, on `main` with
  `@_linked/server` 2.24.8 as well as with 3.0.0. Reads still pass (anonymous reads only warn).
status: Open -- found while moving the template to @_linked/server 3; no fix chosen
---

# 015 — React Native template: anonymous writes are refused

## Symptom

`FUSEKI_PORT=<compose port> npm run test:integration` in a freshly generated app:

```
✓ uses the test API and a real fetch
✕ lists 0, adds one (1), edits it, deletes it (0)
ServerCallError: Authentication required
```

The same result with the template on `main` (server 2.24.8) and with server 3.0.0, so it is not caused
by the server 3 rename.

## Cause

`@_linked/server-utils`' `checkQueryAccess` (`utils/QueryAccess.js`): a store with no declared rule gets
the rule `'session'`. An anonymous read passes with a one-time warning until `rpcExposure` is
`'enforce'`; an anonymous mutation is refused with 401. `services/api/linked.backend.storage.ts` calls
`LinkedStorage.setDefaultDataset(appData)` without `withAccess`, and the template has no sign-in.

## Options

1. Declare an explicit rule on `appData` in `services/api/linked.backend.storage.ts`
   (`withAccess(appData, { read: …, write: … })`), open for the example in development only.
2. Give the template a sign-in, so the example screen runs with a session.
3. Change the example to read-only and leave writes to the app author.

The choice is an access-policy decision for the template, so it is left to the owner.
