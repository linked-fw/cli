---
'@_linked/cli': patch
---

`build` now sets the executable bit on its bin output.

`package.json` declares `"bin": {"linked": "lib/esm/launch.js"}`. A package
manager sets that file's executable bit at install time; an in-place rebuild does
not, and `lib/` is gitignored so git preserves no mode either. So after a local
rebuild, anything spawning `linked` fails with `EACCES` on a file that plainly
exists — a confusing failure, and one that has bitten the integration harness.

`npm run build` now ends with `chmod +x lib/esm/launch.js`.
