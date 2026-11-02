---
"@_linked/cli": minor
---

`linked worktree add --dataset <name>` and `linked branch start <m> --worktree --dataset <name>` now print how to fill the new dataset from the app's own clone script instead of fixed script paths:

- The app adds an npm script `clone-dataset` to its root `package.json` that copies its data into the dataset named by its one argument. The hint is then `Clone the data into <name> first (from <root>): npm run clone-dataset -- <name>`.
- To use another script name, set `datasetCloneScript` in `linked.config.js`: `defineConfig({datasetCloneScript: 'data:clone'})` (new optional `LinkedConfig` key).
- Without the script (or when `datasetCloneScript` names a script `package.json` lacks), a warning says the dataset starts empty unless it is cloned by hand, and how to add the script.

New exports from the worktree command module: `datasetCloneHint`, `datasetCloneMessages`, `readDatasetCloneScript`, `DEFAULT_DATASET_CLONE_SCRIPT`, `appPort`; `DEFAULT_APP_PORT` (4040) from the start command.

Wording: `worktree add` without `--port` names the app's own port (its `.env` `PORT`, else 4040) as the main checkout's, and `branch land` says "Restart the app on …". See `docs/integration-branches-and-worktrees.md`, "Cloning a dataset".
