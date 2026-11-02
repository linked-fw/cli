---
summary: >
  Gaps left by the `branch` key of `linked.unpublishedPackages` (report 043): a push-mode merge
  whose app is already up to date does not strip keys the target still lists; the strip rewrites
  `package.json` through `JSON.stringify` (inline objects expand); no command sets a key.
source: report 043 (Follow-ups), 29 Oct 2026
status: open
---

# 016 — Branch key follow-ups

1. **Up-to-date app, keys on the target.** `linked branch merge --mode push` strips the app's keys
   inside the app's merge commit. When `origin/<into>` already contains `origin/<branch>` there is
   no merge commit, so nothing is stripped; the run only says so (`… its package.json was not
   changed, so check it lists no branch key`). That happens only when the branch reached the
   target some other way. Idea: a commit `Use <into> of <pkgs>` on `<into>` in that case, or a
   refusal.
2. **Formatting.** The strip parses `package.json`, deletes the keys and writes it with the file's
   indent and trailing newline (and CRLF when the file has it). An object the file kept on one line
   (`{"repo": "…"}`) comes back expanded. npm and Create Now write `JSON.stringify(…, null, 2)`, so
   in practice nothing moves; a text-level edit would keep any layout.
3. **Setting a key.** Nothing in the cli writes a `branch` key; Create Now edits `package.json`
   itself. A `linked use <pkg> --branch <b>` (and `--clear`) would give developers the same, if
   wanted.
