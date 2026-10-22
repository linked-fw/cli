---
"@_linked/cli": minor
---

`linked release plan [--json]` shows, per repo on the integration branch in dependency order (the app last), the commits, reports (with their `## PR` section) and changesets the target lacks, the release PRs (head `<integration>--*`) in stack order with their state, and the next action. It warns when a changesets repo adds no changeset (merging would not publish) and when `origin/<target>` has commits the local target lacks; it compares against the local targets and never fetches.
