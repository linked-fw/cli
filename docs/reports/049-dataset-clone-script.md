---
date: 2026-11-02
summary: >
  `worktree add --dataset` and `branch start --worktree --dataset` print the app's own clone
  command (`npm run clone-dataset -- <dataset>`, or the script `datasetCloneScript` names in
  linked.config.js) and warn when the app has none; the port hint names the app's port and the
  land message says "Restart the app". Minor.
packages: [cli]
---

# 049 — Dataset clone hint from the app's npm script

## PR

### Summary

The `--dataset` hint of `linked worktree add` and `linked branch start --worktree` checked for
two shell scripts of one particular host app and printed their commands. It now asks the app:
an npm script `clone-dataset` in the app's root `package.json` (or the one `datasetCloneScript`
names in `linked.config.js`) that takes the target dataset as its one argument. Without it, a
warning says the dataset starts empty and how to add the script. Two output strings no longer
assume a host: the free-port hint names the app's own port, and `branch land` says "Restart the
app on …". Follow-up of report 048.

### Changes

- `src/commands/worktree.ts`: one shared helper set, used by both commands:
  `datasetCloneHint(root, dataset, configured?)` (pure: the lines to print),
  `readDatasetCloneScript(root)` (the linked config's `datasetCloneScript`, undefined on no
  config / no key / a config that fails to load), `datasetCloneMessages(root, dataset)` (the two
  combined), `DEFAULT_DATASET_CLONE_SCRIPT = 'clone-dataset'`, and `appPort(root)` (the root
  `.env`'s `PORT`, else `DEFAULT_APP_PORT`). `worktreeAdd` uses them for the clone hint and the
  `(pick a free port: the main checkout uses <port>)` line.
- `src/commands/master.ts`: `branch start --worktree --dataset` prints `datasetCloneMessages`;
  `branch land` says "Restart the app on <root>".
- `src/commands/start.ts`: `DEFAULT_APP_PORT` (4040), used by `resolveAppUrl`.
- `src/interfaces.ts`: optional `LinkedConfig.datasetCloneScript`.
- `src/cli.ts`: `--dataset` help of both commands mentions the clone command.
- Docs: `docs/integration-branches-and-worktrees.md` (new "Cloning a dataset" section, the flag
  table, the master section, the "Data is shared" limitation), `README.md` (one example line).
- Tests: `tests/unit/datasetCloneHint.test.ts` (new), `tests/unit/integration/worktree.test.ts`
  (the `--dataset` test rewritten; a new one for the warning and the port line).
- Changeset `.changeset/dataset-clone-script.md`: minor.

### Verification

- `npx linked build` → `✔ Build successful`.
- `npm run test:unit` → `Test Suites: 104 passed, 104 total`, `Tests: 1279 passed, 1279 total`.
- `npm run test:e2e` → `7 passed (2.0m)`.
- Against a real host app (its linked.config.js imported by the built `lib/`):
  `datasetCloneMessages(<app with the script>, 'wt-x')` →
  `'Clone the data into wt-x first (from <app>): npm run clone-dataset -- wt-x'`; against a
  checkout without the script →
  `'Warning: the app has no clone-dataset script, so wt-x starts empty unless it is cloned by hand.'`
  plus the how-to line.
- A case-insensitive grep for the host's name, abbreviation and dataset names over the changed
  files finds nothing.

### Deviations

- None from the settled design. The helper lives in `worktree.ts` (not its own module) because
  `master.ts` already imports its start-command helpers from there and a separate module would
  have needed `shellQuote` from `worktree.ts`, an import cycle.

### Follow-ups

- `src/vite-config.ts` still has its own `DEFAULT_DEV_PORT = 4040` and two literal `4040`s; it
  could use `DEFAULT_APP_PORT`. Not recorded elsewhere; small cleanup.

## Details

### Behaviour

| app state | printed |
|---|---|
| `package.json` has `scripts["clone-dataset"]`, no config key | `Clone the data into <ds> first (from <root>): npm run clone-dataset -- <ds>` |
| `datasetCloneScript: 'x'` and `scripts.x` exists | the same with `npm run x -- <ds>` |
| `datasetCloneScript: 'x'`, no `scripts.x` (even if `clone-dataset` exists) | `Warning: datasetCloneScript in the linked config names "x", but <root>/package.json has no such script, so <ds> starts empty unless it is cloned by hand.` + how to add `x` |
| neither | `Warning: the app has no clone-dataset script, so <ds> starts empty unless it is cloned by hand.` + how to add `clone-dataset` or set `datasetCloneScript` |

The dataset is shell-quoted in the command (`shellQuote`), shown raw in prose. `<root>` is the
app's main checkout (where the script has to be run, since it needs the main install).

### Decisions

- **Config source:** the app's linked config, `linked.config.js` (or legacy `lincd.config.js`),
  found with `resolveLinkedConfigPath` and loaded with `importFile`, the same way `linked start`
  reads it. A config that throws on import (for example, one that imports something unavailable)
  is treated as "no key", so the hint falls back to the default script instead of failing
  `worktree add`.
- **An override naming a missing script warns** rather than falling back to `clone-dataset`: the
  app said which script to use, so printing another one would be wrong.
- **Port:** `appPort(root)` reads the main checkout's `.env` `PORT` with the existing
  `envValue` parser; `DEFAULT_APP_PORT` is the same 4040 `resolveAppUrl` falls back to.
- The cli prescribes only the interface (one positional argument, the target dataset). The docs
  recommend the script refuse to overwrite the app's own datasets.

### Tests

- `tests/unit/datasetCloneHint.test.ts` (11 tests): script found; dataset shell-quoting; config
  override found; override naming a missing script (warns, does not mention `clone-dataset`);
  no script; no `package.json`; `readDatasetCloneScript` reading a temp `linked.config.js`, no
  config / no key, a throwing config falling back; `datasetCloneMessages` with the configured
  script; `appPort` from `.env` and the default.
- `tests/unit/integration/worktree.test.ts`: `--dataset` with a committed `clone-dataset` script
  prints its command; `--dataset` without one prints the warning, and without `--port` the line
  names the `.env` port (4100).
