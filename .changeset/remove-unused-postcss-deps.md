---
"@_linked/cli": patch
---

Remove the unused `postcss`, `postcss-url` and `@tailwindcss/postcss` dependencies. Tailwind is compiled by `@tailwindcss/vite` (still a dependency), and Vite brings its own `postcss`.
