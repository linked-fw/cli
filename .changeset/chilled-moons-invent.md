---
'@_linked/cli': minor
---

Compile the app backend with Vite instead of bare `tsc`.

`linked start` already loads `src/backend.ts`, `src/App.tsx` and
`src/routes.tsx` through `vite.ssrLoadModule`, so production was resolving the
same source a different way. `tsc` could not follow the workspace resolver or
an extensionless relative import, it inferred `rootDir` from whatever happened
to be in the program (so `lib/backend.js` could land in `lib/src/`), and being
a typechecker first it failed the build on any type error anywhere in the app —
including in files the backend never loads. Emitting and typechecking are
separate concerns.

Workspace packages are named in `ssr.external`. Vite will not externalize them
on its own: a workspace symlink realpaths out of `node_modules`, and Vite
refuses to externalize anything that does not look like it lives there, so they
were all compiled into `lib/` — giving the app a second copy of
`@_linked/core` and splitting `LinkedStorage`'s routing state from the one the
storage config configures. A post-build check now fails the build if any
workspace package ends up inlined, rather than leaving it to surface as a
storage-routing error at boot.

Note the consequence: a release build resolves workspace packages through their
published exports, so **their `lib/` must be built and current**. A stale one
fails the build with a message saying so.
