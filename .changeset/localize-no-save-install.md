---
'@_linked/cli': patch
---

`linked localize` no longer leaves a `package-lock.json` diff in the checkouts it reinstalls. Every install it runs inside a checkout (localize, `--adopt`, `--relink`'s reinstall, `--reinstall`) is now `npm install --no-save`: it installs what the checkout's committed lockfile says and writes neither its `package.json` nor its `package-lock.json`. A plain `npm install` rewrote the lockfile in the dialect of whichever npm was first on PATH — Node 22's bundled npm 10.9.9 dropped every `"libc"` field an npm 12 lockfile records — and synced any lockfile header a release had bumped. To change a checkout's dependencies, run `npm install <dep>` inside it on purpose.
