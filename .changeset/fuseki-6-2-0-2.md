---
'@_linked/cli': minor
---

The CLI and the `defaults/package` template depend on `@_linked/core` `^2.38.0` (named graphs and
the graph registry). The e2e's default `FUSEKI_IMAGE` is `ghcr.io/linked-fw/fuseki:6.2.0-2`, the
image that builds its class hierarchy from the graph registry.

Breaking changes:

- `@_linked/core` 2.38 requires `ghcr.io/linked-fw/fuseki:6.2.0-2`, or a store that builds its
  hierarchy from the graph registry: on `6.2.0-1` classes declared in package graphs do not infer.
- Packages created from `defaults/package` start on `@_linked/core` `^2.38.0`.
