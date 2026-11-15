---
"@_linked/cli": minor
---

The start commands of `linked worktree add` and `linked branch start --worktree` set the app's projects root only when the app declares its env var, and every worktree (a step or an agent, not only a master's preview) now gets its own:

- New `worktree` settings in `linked.app.json`: `{"worktree": {"projectsRootVar": "MY_PROJECTS_ROOT", "testPortVar": "MY_TEST_PORT"}}` (env var names; the schema `https://linked.cm/schema/app/1.json` has the key).
- When `projectsRootVar` is declared and the `.env` sets that var, the printed start command sets it to the worktree's own directory: the `.env`'s relative value under the worktree, or the last segment of an absolute value under it. `worktree add` prints it too, so an agent's checkouts never land in the main checkout's.
- A master's preview message names the test-run port as `<testPortVar>=<port + 1>` when declared, else `port <port + 1>`.
- No env var name of a particular app is built in any more: an app that relied on the old built-in name declares it as `projectsRootVar` and `testPortVar`.

New exports from the worktree command module: `worktreeSettings`, `worktreeProjectsRoot`; `startEnv` drops its `preview` argument. New type `AppWorktreeSettings`.
