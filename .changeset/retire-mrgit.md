---
'@_linked/cli': patch
---

`linked yarn` no longer reads a multi-repo manifest from the cwd. The tool that
produced nested sibling repos under `packages/` is retired, so there are no
nested yarn.lock files to back up: the command is now a plain, arg-preserving
passthrough to yarn.
