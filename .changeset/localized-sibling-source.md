---
'@_linked/cli': patch
---

The dev resolver registers every localized package as source, including one that another localized package depends on. The dependency walk used to key "visited" on the package name and go depth-first, so reaching a checkout's own `node_modules` copy of a sibling (a lib-only registry install) first hid the app's localized checkout of that sibling: Vite served it from `lib/`, and the depending checkout's imports went to its nested copy. The walk is now breadth-first and keyed on the installed directory.
