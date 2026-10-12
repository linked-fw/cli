---
'@_linked/cli': patch
---

`linked localize`'s prune no longer removes a checkout's own copy of a package that ships its own types while the checkout also holds an `@types/` stub for it. With the copy gone, TypeScript resolved the package to that stub instead of the app's copy — measured as `@_linked/cli`'s own build failing with `TS2724 '"minimatch"' has no exported member named 'minimatch'` once the app's `minimatch` moved into the checkout's range while the checkout kept `@types/minimatch@3` (depcheck → multimatch). The copy is kept and reported (`linked localize --list` names the stub), and a checkout an earlier prune left in that state counts as missing the package, so `--relink` reinstalls it.
