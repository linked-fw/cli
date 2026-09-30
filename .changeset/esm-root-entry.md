---
'@_linked/cli': patch
---

`import('@_linked/cli')` works in Node again. The root entry re-exported its modules with extensionless specifiers (`./tailwind.config`, `./utils`, …), which Node's ESM resolver does not complete, so importing the package failed with `ERR_MODULE_NOT_FOUND`. The source now names the `.js` files, and a unit test rejects extensionless relative imports anywhere in `src`.
