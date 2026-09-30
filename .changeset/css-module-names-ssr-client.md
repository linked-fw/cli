---
"@_linked/cli": patch
---

Server-rendered components from packages now get the CSS-module class names the client's stylesheet defines.

In a production build the client (Vite) named CSS-module classes by a hash of the processed CSS, while the Node CSS loader that `serve-app` uses for packages in `node_modules` (e.g. every `@_linked/primitives` component) hashed the class with the file's absolute URL. The two never agreed, so every element the server rendered from a package carried a class no stylesheet defined — for example the loading spinner and `Typography` were unstyled on first load, and stayed unstyled after hydration because React does not patch class names.

Both now use one `generateScopedNameProduction`: `_<class>_<hash>`, hashing the owning package's name, the file's path inside it (without `src/`, `lib/esm/` or `lib/cjs/`) and the class, so the name does not depend on the install location or build flavour. The Node loader also finds every class a stylesheet defines (it used to miss a class directly followed by `{`, `.`, `,` or `>`, and truncated hyphenated ones), and uses the development names only when `NODE_ENV` is `development`, matching `startServer`.
