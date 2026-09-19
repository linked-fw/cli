---
'@_linked/cli': minor
---

`setup-publish` scaffolds the consolidated pipeline: two thin caller stubs (`pr.yml`, `publish.yml`) for the shared reusable workflows in `linked-fw/.github` instead of three standalone workflows, and `--configure-github` applies the uniform branch-protection profile (required check `checks / Build & Test`, non-strict, admins enforced). `publishConfig.provenance` is no longer stripped now that publishing is OIDC-first, and `--dual-branch` is a deprecated no-op.
