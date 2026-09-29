---
'@_linked/cli': minor
---

Add `linked localize` and `linked delocalize`, for developing an npm dependency
from a git checkout.

`linked localize <package…>` clones the package's repository (resolved from the
registry's `repository` field), installs inside the checkout, builds it and
symlinks it into `node_modules` — without touching `package.json` or
`package-lock.json`. `--list`/`--check` report what is localized and whether it
really is, `--relink` recreates the recorded symlinks and is what a
`postinstall` should run, and `delocalize` undoes it.

The work is done by the new dependency-free `@_linked/localize`, which
deliberately has no opinion about how a checkout is built. That is the only
thing this CLI adds: it supplies `linked build` as the build command
(overridable with `--build`, disabled with `--build ""`).

Packages are named exactly as npm names them; there is no short-name expansion
and no org probing.
