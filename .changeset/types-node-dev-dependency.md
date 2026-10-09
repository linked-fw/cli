---
"@_linked/cli": patch
---

`@types/node` is no longer installed into consumers. It was declared as a runtime dependency (`^20.12.7`), which forced a second, older copy of the Node typings into every project that installed the CLI — even ones that already declare a newer `@types/node`. It is now a development dependency of the CLI only (`^24.0.0`, matching the Node 24 runtime).

Nothing the CLI scaffolds relies on it: the app, package and React Native templates each declare their own `@types/node`. If your project's `tsconfig.json` lists `"types": ["node"]` (or imports the CLI's Node-facing helpers such as `vite-config`, whose declarations use `NodeJS.ProcessEnv`) and does not declare `@types/node` itself, add it to your own `devDependencies`.
