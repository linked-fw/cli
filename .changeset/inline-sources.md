---
"@_linked/cli": patch
---

The package template's tsconfig (and the CLI's own) now sets `inlineSources`, so published source maps carry their sources instead of pointing at an unshipped `src/`.
