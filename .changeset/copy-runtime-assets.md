---
"@_linked/cli": patch
---

`linked build-all` copies CSS, JSON, declaration files, and SCSS from `src` into `lib/esm` after each package's build script succeeds. When the package publishes CommonJS, the same files are also copied into `lib/cjs`. `tsc` does not emit those files, so a package whose build script is only a TypeScript compile was publishing a `lib` tree that could not import them.

A failed copy fails that package's build. Copied files are no longer removed afterward just because their timestamp is older than two minutes, as long as the source file under `src` still exists.
