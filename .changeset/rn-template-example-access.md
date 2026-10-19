---
'@_linked/cli': patch
---

React Native template: the example screen can add, edit and delete a Person again. `services/api` now attaches the web app-template's example access rule to its `appData` store (`withAccess`, `services/api/src/exampleAccess.ts`): anonymous reads of `Person` in every environment, anonymous writes of `Person` only under `NODE_ENV=development`, and a session for everything else. A new integration test starts a second API with `NODE_ENV=production` and checks that it refuses anonymous create, update and delete with 401.
