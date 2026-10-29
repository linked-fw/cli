---
'@_linked/cli': minor
---

An app's `linked.unpublishedPackages` entry can name the package branch the app branch uses:
`{"repo": "…", "branch": "rene/topic"}`. The key must be a valid git branch name other than
`main` (anything else is refused, exit 6, naming the entry); only the app's own list counts, and a
key in a package's list is ignored with a warning. `linked checkout` reads the keys as pins (an
explicit `--pin` wins; `pinFrom: "key" | "flag"` in `--json`), `linked localize --listed` clones a
keyed package on its branch, and `linked branch merge` lands a keyed package branch before the
packages on the app branch and strips every key from the app's `package.json`: inside the app's
merge commit with `--mode push`, in one commit `Use <into> of <pkgs>` on the branch with `--mode
update`, which refuses a keyed branch the target does not contain yet. `MergeResult.strippedKeys`
and `MergeRepo.via` report it.
