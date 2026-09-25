---
'@_linked/cli': minor
---

`setup-publish` now points each caller stub at the shared workflows in **the repo's own org**
(`<owner>/.github/.github/workflows/*.yml@v1`) instead of always `linked-fw/.github`. Each org
keeps its own copy of the reusable workflows, so community repos in `linked-cm` no longer reach
cross-org for their CI — and their gates can diverge from the first-party ones without affecting
`@_linked` packages.

The npm secret is now always `NPM_AUTH_TOKEN`. The `NPM_AUTH_TOKEN_CM` name dated from before
first-party and community repos were split into two GitHub orgs, when one org had to hold both
scopes' tokens at once; now each org holds its own token under the same name. `--scope` is
deprecated and ignored, accepted only so stale scripts still set a repo up rather than aborting on
an unknown option.
