---
summary: >
  `linked localize` / `linked delocalize` are thin adapters over the published `@_linked/localize`;
  the CLI's only real contribution is the build seam (`build: 'linked build'`). Records what was
  deliberately left out — no resolver hook, no short-name expansion — why the exit-code adapter
  is shaped the way it is, how the retirement of `buildApp` had been crashing a consumer's
  `postinstall` invisibly, and how this repository's release automation actually works.
---

# `linked localize` and `linked delocalize`

`830b7b9`, PR [#173](https://github.com/linked-fw/cli/pull/173), released in **1.29.0**.

## What lives where

Essentially all of the mechanism is in [`@_linked/localize`](https://www.npmjs.com/package/@_linked/localize),
which is dependency-free and knows nothing about this framework on purpose: npm name → the
registry's `repository` field → clone → install **inside the checkout** → symlink into
`node_modules` → record in a gitignored `local-packages.json`. It never touches `package.json` or
`package-lock.json`. It was extracted from a private CLI's `localize` so the mechanism is not tied
to one.

`src/commands/localize.ts` is two commander commands and two adapters. Keeping it that thin is
the design: this repository owns the *ecosystem* half of the question and nothing else.

## The build seam is the contribution

`@_linked/localize` deliberately does not know how to build what it cloned. That is the one thing
this package supplies:

```ts
export const DEFAULT_BUILD_COMMAND = 'linked build';
```

`--build <cmd>` overrides it; `--build ""` builds nothing. A failing build only warns — a package
whose build is broken is usually exactly what you localized it in order to fix, and aborting there
would leave a half-linked tree.

## The exit-code adapter, and why it does not exit

`localize` reports failure through a **return value**, never by throwing. The adapters mirror that
by setting `process.exitCode` and returning, rather than calling `process.exit`:

> `localize` reports failure through an exit code rather than by throwing, so that a partial run
> still prints what it did.

`process.exit` truncates pending stdout. A partial run whose output is cut off is worse than a
failed run, because the half that did succeed is what tells you where you are.

## Deliberately absent

- **No short-name expansion.** Full npm names only — `@_linked/core`, not `core`. A bare name is
  ambiguous the moment someone localizes a third-party package, and resolution is the registry's
  `repository` field rather than a guess against a list of orgs.
- **No resolver hook in `@_linked/localize`.** It should not grow one. The registry already
  answers the question; a hook would make the answer depend on which CLI invoked it.
- **`delocalize` is a separate command, not `localize remove`.** `linked localize remove <name>`
  would read `remove` as a package name and try to clone it.

Parity with the standalone binary was verified directly: `--list`, `--list --check` and a
schema-version refusal produce byte-identical output and identical exit codes through
`linked localize` and through `linked-localize`.

## The finding: retiring `buildApp` had been crashing a consumer's `postinstall`

The consuming project's `postinstall` ran the *old*, private `localize` binary, which imports
`buildApp` from `@_linked/cli/cli-methods`. [Report 004](004-webpack-retired.md) removed that
export. From 1.28 onward the hook died with

```
SyntaxError: The requested module '@_linked/cli/cli-methods' does not provide an
export named 'buildApp'
```

— and no version constraint was violated, because 1.28.2 sits inside the `^1.25.2` range that
consumer's CLI declares. It was invisible for weeks because the hook ended in `|| true`.

Two things for a maintainer of this package to carry forward. **A removed export is a breaking
change for importers of `cli-methods` even when the command that used it is gone**; the semver
range will not catch it, because the importer is a different package. And **`|| true` on an
install hook converts a hard failure into a slow one**: the symptom surfaces later, somewhere
unrelated, as a package that is mysteriously not linked.

## Retraction: the stated reason for extracting this was false

The extraction was justified as *removing private-npm auth from the install path*. That premise
was **not true**. The CLI it was extracted from is public (`npm access get status` → `public`),
and a credential-free clone and install of a consuming app was measured to succeed with the old
hook in place.

Whether it was ever `restricted` at some earlier point is **not established in either direction**,
and no instrument exists for the question — which is the honest way to leave it rather than
quietly substituting a better-sounding reason after the fact.

The real reasons, both checkable: the crash above, and that the private CLI drags ~1499 packages
into any consumer that installs it.

## How a release of this repository actually happens

Worth stating because it surprises people who look for a manual publish step. There is none.

- A changeset in `.changeset/` is what marks a change as releasable.
- Changesets opens the release PR; the workflow **merges it itself** using a GitHub App token
  (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`).
- Publishing to npm uses **OIDC trusted publishing** — hence `id-token: write` in
  `.github/workflows/publish.yml`. That permission is declared in the *caller* as well as in the
  shared workflow, because a reusable workflow cannot widen what its caller was granted, and
  without it npm never gets an id-token and releases silently fall back to the approval queue.
- `.github/workflows/publish.yml`'s **filename** is what npm's trusted-publisher check validates.
  Renaming it invalidates the trusted publisher, and the only symptom is that approval queue
  reappearing.

So a change that needs releasing needs a changeset and nothing else. A **docs-only change needs
none** — `.changeset/config.json` has no `ignore` entries and the PR workflow's changeset check is
a reminder comment, not a gate. This report and its two siblings were committed without one.
