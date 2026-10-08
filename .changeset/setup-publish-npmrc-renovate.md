---
'@_linked/cli': minor
---

`linked setup-publish` now also sets up what every linked-cm package needed by hand:

- an `.npmrc` with `allow-remote=all` (npm 12 otherwise fails `npm install` with EALLOWREMOTE on bundled tarballs), plus `legacy-peer-deps=true` in linked-cm, whose CI installs that way. Keys the repo already sets are kept.
- a `renovate.json` stub extending `<org>/renovate-config`, unless the repo already has a Renovate config.
- `@changesets/cli` ^3 and `@changesets/changelog-github` ^1, the versions the fleet runs.

The lockfile step now keeps the existing lockfile's resolutions and resolves under the repo's `.npmrc`, instead of re-resolving from scratch with `--legacy-peer-deps` everywhere.
