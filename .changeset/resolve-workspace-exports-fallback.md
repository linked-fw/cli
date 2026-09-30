---
'@_linked/cli': minor
---

The dev resolver (`linked:resolve-workspace-ts`, also used by apps' Vitest) no longer needs a `development` -> `src` export condition to load a source workspace from `src`. When a subpath's name matches no file under `src` — a renamed export such as `@_linked/translation/key-sync/node` (`src/key-sync-node.ts`) or a directory export such as `@_linked/documents/conformance` — it reads the workspace's own `exports` (`import`/`default`), maps the `lib/esm/...` target back to `src` (probing `.tsx`/`.ts`) and uses it only if that source file exists. Specifiers the name-based lookup already resolved are unchanged.
