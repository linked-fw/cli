---
'@_linked/cli': patch
---

New packages (`linked create-package`) export `./backend` with a `development` condition that points at `./src/backend.ts`. Before, an unbuilt workspace package's backend was silently not loaded in dev: the server looks up a workspace's backend with the `development` condition and loads it only when the file exists, and the template only pointed at `lib/esm`. The other entries stay lib-only, because `src/` is not published.
