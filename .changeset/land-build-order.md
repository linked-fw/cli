---
'@_linked/cli': patch
---

One dependency order for release PRs, `checkout` and `branch land`, with the build tool ordered as `linked build-all` orders it: the build tool's own dependencies, then the build tool (`@_linked/cli`), then everything else. The packages that devDepend on the build tool while it depends on one of them (`@_linked/core`) formed a cycle, which fell back to name order and could put a package before the build tool. `branch land` therefore built such a package with the old build tool. When the build tool fails to build in `branch land`, the packages after it are not built (and so not pushed).
