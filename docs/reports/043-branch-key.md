---
date: 2026-10-29
summary: >
  The `branch` key of a `linked.unpublishedPackages` entry: parsed and validated (`isBranchName`,
  never `main`), kept only from the app's own list, read by `linked checkout` as pins under
  `--pin` (`pinFrom`), followed by `localize --listed`, and landed by `linked branch merge`, which
  merges keyed package branches first (update mode refuses one the target lacks) and strips every
  key from the app's `package.json` (`strippedKeys`, `via`). Minor. Step BK of CN plan 282 (K7),
  sub-plan 004.
---

# 043 — The branch key

## PR

### Summary

An app branch names the package branch it uses in its own `package.json`:
`"acme-ont": {"repo": "…", "branch": "rene/topic"}`. `linked checkout` places a keyed package as a
pin places it, `linked localize --listed` clones it on that branch, and `linked branch merge`
lands the keyed branch before the packages on the app branch and removes every key, so `main`
lists none. Contract K7 (Added by BK), master decisions M8, M29, M33.

### Changes

- `src/integration/branchName.ts` (new): `isBranchName(name)`, the rules of `git check-ref-format
  --branch` without running git.
- `src/installed-packages.ts`: `UnpublishedPackage.branch?`; `unpublishedPackages()` keeps a valid
  `branch` and refuses (exit 6) `main`, `HEAD`, `""`, an invalid name or a non-string, with
  `linked.unpublishedPackages of <app>: "<name>" has branch <value>, which is not a git branch name
  other than main. …`.
- `src/integration/unpublished.ts`: `walkUnpublished` keeps `branch` only from the root list; a key
  in a package's list is dropped with `<pkg>'s list names branch <b> for <name>; ignored, the app's
  list decides.`; the conflict check stays on `repo`. New `pinsFromKeys(list)` and
  `stripBranchKeys(text)` (removes the keys, keeps key order, indent, trailing newline and CRLF).
- `src/commands/checkout.ts`: the run's pins are `{...pinsFromKeys(appList), ...--pin}`; a key
  alone puts the run in pins mode; `CheckoutPackage.pinFrom: 'key' | 'flag'`; the message `pin
  <npm>=<b> from --pin overrides the app's branch key <k>.` A detached pinned worktree whose head
  origin has now moves to a new pin that is not a fast-forward of it (it was kept: see Deviations).
- `src/localize/localize.ts`: `--listed` clones a keyed entry on its key (fallback to the default
  branch with today's log line), else on the app's branch.
- `src/commands/branch-fork-merge.ts`: `branchMerge` reads the keys from `origin/<branch>:package.json`.
  A key naming `<branch>` is merged as today. A key naming another `<k>`: push mode merges
  `origin/<k>` into `<into>` (`Merge branch '<k>' into <into>`) first, from that package's checkout
  found by npm name (none, or no `origin/<k>`: exit 6, nothing merged); update mode refuses (exit 6)
  unless `origin/<into>` contains `origin/<k>`. Order: keyed packages by dependency, then the
  packages on `<branch>` by dependency, the app last. The strip: push mode amends the app's merge
  commit in the temporary worktree before the push; update mode commits `Use <into> of <pkgs>` on
  the branch after merging `<into>` in, before the push. `MergeResult.strippedKeys: string[]`,
  `MergeRepo.via: 'key' | 'branch'`.
- Help text (`src/cli.ts`: `localize --listed`, `branch merge`, `checkout`, `--pin`, `--pins-only`),
  header comments of `checkout.ts`, `branch-fork-merge.ts`, `localize.ts`.
- Docs: README (unpublished packages, branch checkouts, the merge lines), `docs/localize.md`
  (commands table, the on-disk example with `branch`, a paragraph on the key, exit code 6),
  `docs/integration-branches-and-worktrees.md` (merge: branch keys, push/update, JSON with `via`
  and `strippedKeys`; checkout: branch rule, Pins, Create Now passes `--pins-only` only, JSON with
  `pinFrom`).
- `.changeset/branch-key.md` (minor). Backlog 016.
- Tests: `tests/unit/integration/branchName.test.ts` (new, 37 names against git),
  `unpublished.test.ts` (parser, walk, `pinsFromKeys`, `stripBranchKeys`), `pins.e2e.test.ts`
  (6 key cases), `listed.test.ts` (key wins, missing key branch), `land.e2e.test.ts` (push lands
  keyed first and strips in the merge commit; refusal without a checkout; update refuses, then
  strips in one commit; an app without keys reports `strippedKeys: []`), helpers
  `appJsonWithKeys`/`keyAppBranch`.

### Verification

Build (`npx linked build` in the cli worktree; first one with
`/Users/rene/web/create_now/node_modules/.bin/linked build`):

```
✔ Checking dependencies
✔ Build successful
npx linked build  11.95s user 1.78s system 166% cpu 8.249 total
```

The plan's jest list (`unpublished`, `listed`, `pins.e2e`, `land.e2e`, `checkout.e2e`,
`integration/branch`, `integration/branchName`):

```
Test Suites: 7 passed, 7 total
Tests:       113 passed, 113 total
Snapshots:   0 total
Time:        48.612 s, estimated 74 s
```

`npm run test:unit` after the build:

```
Test Suites: 103 passed, 103 total
Tests:       1260 passed, 1260 total
Snapshots:   0 total
Time:        115.954 s, estimated 118 s
npm run test:unit  171.77s user 186.46s system 307% cpu 1:56.53 total
```

End to end with the built bin (`node lib/esm/launch.js`) in
`/private/tmp/claude-501/-Users-rene-web-create-now/f0df7a7f-565a-4b79-a371-d7fb1ca89a28/scratchpad/cli-sandbox`,
`file://` remotes `acme-app`, `acme-ont` (branch `rene/topic`), `acme-assets` (branch `change-1`);
the app's `change-1` keys `acme-ont` to `rene/topic`. Script `bk-sandbox.sh` in the scratchpad;
whole run 12.5 s. Packages from `--json` (paths trimmed):

```
== 1. checkout change-1 --pins-only --json (the key is the pin)       [exit 0 in 1.8 s]
{"name":"acme-ont","branch":"rene/topic","detached":true,"fellBack":false,"pin":"rene/topic","pinFrom":"key","status":"created"}
{"name":"acme-assets","branch":"main","detached":true,"fellBack":true,"status":"created"}
== 2. the same with --pin acme-ont=main (the flag wins)               [exit 0 in 1.8 s]
{"name":"acme-ont","branch":"main","detached":true,"fellBack":false,"pin":"main","pinFrom":"flag","status":"updated"}
{"name":"acme-assets","branch":"main","detached":true,"fellBack":true,"status":"unchanged"}
message: pin acme-ont=main from --pin overrides the app's branch key rene/topic.
== 3. back to the key                                                 [exit 0 in 1.78 s]
{"name":"acme-ont","branch":"rene/topic","detached":true,"fellBack":false,"pin":"rene/topic","pinFrom":"key","status":"updated"}
{"name":"acme-assets","branch":"main","detached":true,"fellBack":true,"status":"unchanged"}
== 4. localize --listed in a developer clone on change-1               [exit 0 in 2.06 s]
[localize] acme-ont -> packages-local/acme-ont (branch rene/topic)
[localize] acme-assets -> packages-local/acme-assets (branch change-1)
== 5. branch merge change-1 --into main --mode push (in the checkout)  [exit 0 in 2.96 s]
{"code":0,"repos":[["acme-ont","merged","key",true],["acme-app","merged","branch",true]],"strippedKeys":["acme-ont"],"messages":[]}
$ git -C remotes/acme/acme-ont.git log --format=%s -2 main
Merge branch 'rene/topic' into main
initial
$ git -C remotes/acme/acme-app.git log --format=%s -1 main
Merge branch 'change-1' into main
$ git show origin/main:package.json   (the unpublishedPackages part)
    "unpublishedPackages": {
      "acme-ont": {
        "repo": "file:///…/cli-sandbox/remotes/acme/acme-ont.git"
      },
      "acme-assets": {
        "repo": "file:///…/cli-sandbox/remotes/acme/acme-assets.git"
      }
    }
branch keys on origin/main: 0
```

(`acme-assets` is not in the merge: `--pins-only` left it detached at `origin/main`.)

Not run: `npm run test:e2e` (Docker); CN's tests (CN half).

### Deviations

- **A pinned worktree now moves on a non-fast-forward pin change.** The first sandbox run showed
  step 2 `kept` (`its detached HEAD has commits origin/main lacks`): a detached pinned worktree
  only fast-forwarded, so changing a pin from `rene/topic` back to `main` (or a key overridden by
  `--pin`) left it where it was, against the documented "a clean worktree whose head origin has
  moves to its target when the pins change". The pinned path now moves when origin has the head,
  as the default-branch path already did. Applies to `--pin` changes too. Test added.
- The keys become pins **before** the walk (the plan says after): packages are placed during the
  walk, so the app list's keys must be known first. They come from the app worktree's
  `package.json` after the app is brought up to date, the same file the walk reads.
- The update-mode strip commit is `Use <into> of <pkgs>` (`Use main of acme-ont` when `<into>` is
  `main`), names comma-separated.
- `MergeRepo.landed` for a `via: "key"` package compares `origin/<k>` with `origin/<into>`.

### Follow-ups

- Push mode with an app already in `<into>` does not strip keys `<into>` might list (message
  only); the strip reflows one-line objects; no command sets a key: cli backlog
  [016](../backlog/016-branch-key-follow-ups.md).
- CN half (CN reads `pinFrom`/`strippedKeys`/`via`, passes `--pins-only` without `--pin`, lands
  keyed branches by PR before update mode): CN plan 283 §BK.
- Landing into `hub-imports` and building in the master's cli worktree: the step agent (this
  report leaves the work on `hub-imports--bk`).

## Details

### Design

The parser stays pure (`isBranchName` instead of a git call); `checkout` still runs `git
check-ref-format --branch` on each key as it does on each `--pin`. Keys are read only from the
app's list (M8: the on-disk shape is unchanged, `{"<npm name>": {"repo", "branch"?}}`); the walk
copies a transitive entry without its key, so nothing downstream can see one. In `checkout` the
pin set is one map built once (`pinKeys`), and a `keyed` set says which pins came from keys, so
`targetOf` and every pins-mode rule are unchanged (M29). In `branch merge` the keys come from
`origin/<branch>` after the fetch, and every refusal (no checkout for a keyed package, no
`origin/<k>`, update mode with `<k>` not in `<into>`) joins the existing "Nothing was merged"
pre-check, so a refusal never leaves a half merge (M33).

### Autonomous decisions

| # | Where | Problem | Choice | Alternative | Rationale |
|---|---|---|---|---|---|
| B1 | walk | "one warning" for a transitive key | One warning per dropped key, naming the list, the branch and the package | One warning per run | Each names what was ignored; the plan's sentence is per key |
| B2 | checkout | Keys must be pins before packages are placed, which happens inside the walk | Read the keys from the app list before the walk (after the app worktree is up to date) | After the walk, as the plan worded it | The only order that places keyed packages; same file |
| B3 | checkout | A key git's `check-ref-format` refuses (the parser already checked) | Refused with exit 6 (a list error), not 2 | Exit 2 like a bad `--pin` | A key is committed data, not the command line; matches the parser |
| B4 | checkout | Override message when `--pin` equals the key | No message; `pinFrom: "flag"` | Always a message | Nothing is overridden |
| B5 ⚠ risky | checkout | A detached pinned worktree was kept on a non-fast-forward pin change (also for `--pin` alone, before this step) | Move it when origin has its head, as the default-branch path does | Leave it; record a backlog item | Documented behaviour; without it `--pin` over a key, and a key change, never take effect on an existing checkout. Changes today's `--pin` behaviour in that case |
| B6 | merge | A keyed other-name package whose checkout is on `<branch>` too | The key decides: merged from `origin/<k>` only, left out of the same-name set | Merge both | The app list says which branch the app uses |
| B7 | merge | Strip commit message: plan says `Use main of <pkgs>` | `Use <into> of <pkgs>` | Literal `main` | Same text for `--into main` (CN's case); correct for any target |
| B8 | merge | Hooks on the strip commit and the amend | `--no-verify` | Run the app's hooks | A mechanical edit by the cli; the merge itself runs no pre-commit hook either; the pushes already use `--no-verify` |
| B9 | merge | Push mode, app already in `<into>` (no merge commit to amend) | Message only | Commit on `<into>`, or refuse | No path to it in normal use; backlog 016 |
| B10 | merge | Update mode: how to report keyed packages already in `<into>` | In `repos` as `up-to-date`, `via: "key"`, `landed: true`, `sha` = `origin/<into>` | Leave them out | The caller sees every package the merge considered |
| B11 | merge | Update mode, app up to date but keyed | The strip commit is pushed; app `result: "merged"` | `up-to-date` | Something was pushed; CN opens the app PR on it |
| B12 | merge | App push refused after the strip | `strippedKeys` reset to `[]` | Keep the names | Nothing reached `<into>` |
| B13 | merge | Strip commit fails | `result: "conflict"` with the message, exit 6 | A new result value | Keeps `MergeRepoResult` unchanged for CN |
| B14 | merge | `origin/<branch>:package.json` unreadable / invalid list | No file: no keys; invalid JSON or list: refused with the parser's message, exit 6, nothing merged | Ignore the keys | A list the cli cannot read must not be landed |
| B15 | strip | Formatting | Parse, delete, `JSON.stringify` with the detected indent, trailing newline and CRLF kept | Text-level edit | The plan's prescription; backlog 016 for one-line objects |
