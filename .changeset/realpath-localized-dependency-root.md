---
'@_linked/cli': patch
---

`discoverWorkspaces` now realpaths a linked dependency's root before registering it, not only
before recursing into its own dependencies. The root came from the `node_modules/<name>` symlink
while Vite's resolver realpaths every id it produces, so a package installed as a symlink to a
checkout outside the workspace (a `packages-local/<pkg>` localized checkout) was served under two
ids — `/node_modules/<name>/src/…` and `/<real path>/src/…`. Two module ids mean two module
instances: React context and Linked registration state split, surfacing as errors like
`useAuth must be used within a ProvideAuth component`.
