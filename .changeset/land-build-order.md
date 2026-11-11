---
'@_linked/cli': patch
---

`linked branch land` builds the landed packages in the order `linked build-all` uses: the build tool (`@_linked/cli`) and its own dependencies first, then every other package, which builds with it, even when its `package.json` does not list it. When the build tool fails to build, the packages that build with it are not built (and so not pushed).
