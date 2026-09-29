---
"@_linked/cli": minor
---

`linked build` gains a "Checking shape names" step that warns about compiled shapes without `@linkedShape({name})` whose module also reads `process.env` or `import.meta.env` — the ones a consumer's bundler can rename.
