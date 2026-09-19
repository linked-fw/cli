---
'@_linked/cli': minor
---

npm is now the CLI's default package manager; yarn is detected, not assumed.

A new `detectPackageManager()` walks up from the directory being acted on and
only reports `yarn` when the tree actually is a yarn project (`yarn.lock`,
`.yarnrc.yml`, a vendored `.yarn/releases/`). The nearest marker wins, so an npm
package checked out inside a yarn workspace is treated as npm. Everything else
is npm. Existing yarn monorepos keep working; `linked yarn` (safe-yarn) is
unchanged.

What changed per command:

- `linked build-workspace` runs each package's build with `npm run build`
  instead of always `yarn build` (still `yarn build` inside a yarn workspace).
- `linked build <path>` (the editor hook) invokes the `linked` binary via
  `npx --no-install` instead of always `yarn exec` (yarn, including a vendored
  release, is still used inside a yarn workspace).
- `linked create-package` installs with npm unless the new package lands inside
  an existing yarn project. `planPackageSetup()` gained an
  `insideYarnProject` argument; having yarn on `PATH` no longer selects it. The
  closing hint now names the package manager that was actually used.
- `linked publish` uses `npm version … --no-git-tag-version && npm publish`
  outside a yarn project (Berry's `yarn version` / `yarn npm publish` is kept
  inside one).
- The backend TS compile step uses `npx --no-install tsc` outside a yarn
  project.
- Capacitor setup installs with npm and writes `npx cap …` / `npm run …`
  scripts instead of `yarn cap …`.
- The `create-package` template (`defaults/package/package.json`) builds with
  `npm run …` and bare local bins, so a scaffolded package no longer needs yarn.

Also: the CLI's own `build`, `dev`, `test` and `format` scripts no longer shell
out to `yarn`, so `npm run build` works without yarn installed (previously it
failed under Yarn Berry with "the nearest package directory doesn't seem to be
part of the project", and needed a Yarn 1 shim). Stale yarn mentions in the
README, help text and comments now say npm.
