---
"@_linked/cli": patch
---

A release backend build no longer compiles a private copy of `@_linked/server-utils` and `@_linked/react` into `lib/`. That copy made every provider the app exports fail `LinkedServer`'s `instanceof ShapeProvider` check, so all but one were dropped ("exports two generic backend providers"). `build-app` now also fails if an installed `@_linked/*` package ends up inlined.
