---
"@_linked/cli": minor
---

`linked build-app --compile-only` compiles and checks an app as a build does (environment, Vite client bundle, backend with its checks and data copies) and stops there: it resolves no file store, needs no store `accessURL`, takes no release revision (a dirty tree is fine) and writes no release manifest. It refuses `--target`, `--publish`, `--revision` and `--allow-dirty`. Also exported as `compileViteApp`.
