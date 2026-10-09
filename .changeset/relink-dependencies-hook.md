---
'@_linked/cli': minor
---

Apps now get a `dependencies` relink hook next to `postinstall`, so `npm update`, `npm install <pkg>`, `npm uninstall` and `npm dedupe` keep localized links. npm runs a root `postinstall` only on a bare `npm install` / `npm ci`, but runs a root `dependencies` script after any command that changes `node_modules`. `linked create-package` sets up both scripts, and `linked localize` / `--adopt` add whichever is missing when they record a package (an existing script is kept and the command appended with `&&`; a script that already relinks, including the old `linked-localize --relink` spelling, is left alone).
