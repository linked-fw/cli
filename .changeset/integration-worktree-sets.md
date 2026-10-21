---
'@_linked/cli': minor
---

Integration branches in worktree sets: `linked branch start <name> --target <t> [packages…]` creates a worktree of the app on `<name>` with `node_modules` and gitignored `.env` files linked to the main checkout's and a nested worktree per named package, recording the target in every repository, without switching a main checkout; `linked branch status`, `linked worktree add <agent> [--with …] [--app-detached] [--port] [--dataset] [--dir]` (a package the set lacks joins it with its own nested integration worktree), `linked worktree list`, `linked worktree remove`, `linked release plan` and `linked doctor resolve` complete the workflow. In dev, `@_linked/cli` is no longer bundled by Vite in workspace mode (one copy, Node's), and a worktree with a symlinked `node_modules` gets its own Vite cache (`.vite-cache/`) and no false drift warnings.
