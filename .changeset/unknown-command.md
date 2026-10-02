---
'@_linked/cli': minor
---

An unknown command is now an error instead of an argument to `build`.

`build` is still the default when no command is given (`linked`, `linked --silent`), but
`linked doctor`, `linked yarn` or a typo no longer run a build with that word as its target.
They print `Unknown command "<x>".`, a suggestion when one is close (`doctor` → `app-doctor`,
`yarn` → removed, use npm, or the nearest command by edit distance) and
`Run "linked help" for the list.`, and exit 1.
