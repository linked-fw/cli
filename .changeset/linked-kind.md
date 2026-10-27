---
"@_linked/cli": minor
---

What a `package.json` is comes from `"linked": {"kind": "app" | "ontology" | "assets" | "library"}` alone, through one helper, `linkedKind(json)` (exported from `@_linked/cli/installed-packages`, with `LinkedKind` and `LINKED_KINDS`). A linked package is any kind but `app`. `linkedPackage: true` and `linkedApp: true` are no longer read: `linked build`, `build-all`, `build-package`, Vite's dependency exclusion, the client dependency includes, the shape hierarchy check (no longer by the `@_linked/` scope either), `create-package`'s app lookup and localize's workspace root all go by the kind. `create-package` / `buildPackageFiles` write `linked.kind` (`ontology` or `assets`, merged into the template's `linked` object), the react-native template writes `assets` and `app`, and `create-app` turns the template's `linkedApp: true` into `linked.kind: "app"`. This package's own `package.json` says `"kind": "library"`.
