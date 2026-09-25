---
'@_linked/cli': patch
---

Fix `linked build` failing in the workspace with `TS5055: Cannot write file
'lib/esm/interfaces.d.ts' because it would overwrite input file`.

`cli-methods.ts` loaded `LinkedServer` through a string-literal dynamic import, so TypeScript
resolved it and pulled `@_linked/server`'s emitted `.d.ts` into this package's own program. That
file imports `@_linked/cli/interfaces`, which — through the workspace symlink — resolves back to
this package's `lib/esm/interfaces.d.ts`, an output of the build in progress. Only the workspace
hit this; from a registry install the two packages are separate copies, so CI never saw it.

The specifier now lives in a variable, which stops TypeScript resolving it and reflects what the
import actually is: an optional runtime load. `@_linked/server` cannot become a dependency here —
the CLI runs apps with no backend, and `@_linked/server` already depends on `@_linked/cli`. A
failure to load now reports what is missing instead of an unhandled module error.
