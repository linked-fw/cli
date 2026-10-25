---
'@_linked/cli': patch
---

react-native template: pin the current `@_linked/*` releases (core 2.42.1, schema 1.9.1, server 3.12.1, react 2.0.4, cli 1.57.2), so its typecheck and iOS export pass again. The example shape's property is `name` (`schema.name`), and a Babel plugin turns an `import()` of a computed specifier into a rejected promise, which Hermes can compile.
