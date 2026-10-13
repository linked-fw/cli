---
'@_linked/cli': patch
---

`linked localize`, `--list` and `delocalize` no longer warn about a leftover `local-packages.json`. The file was never read by the workspace-based localize; delete it if one is still around. `docs/localize.md` drops its one-time migration section.
