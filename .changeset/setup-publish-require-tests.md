---
'@_linked/cli': minor
---

`linked setup-publish` now writes `require-tests: true` into `pr.yml` when package.json has a `test` script, matching how every linked-cm package repo is set up. A package without one (a fresh `create-package` scaffold) still gets `false`, with a warning to flip it once a suite exists. Previously the stub always said `false`, so a package's tests could disappear without CI noticing.
