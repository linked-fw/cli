---
summary: build-all copies CSS, JSON, declaration files, and SCSS into lib after each package build, and no longer deletes those copies as stale compiler output.
---

# Runtime assets survive a package build

`linked build-all` runs each package's own `build` script. That script is usually `tsc`, which emits JavaScript and nothing else. CSS modules, JSON data, `.d.ts` files checked in under `src`, and SCSS were copied into `lib` only by the `linked build` step plan. A package whose script is a plain TypeScript compile therefore published a `lib` tree the app could not import styles or data from.

## What changed

`runBuildScript` is the single place `build-all` compiles a package, including the build tool that runs first. After that script exits successfully, it calls `copyRuntimeAssets`. A failed copy fails that package's build (`undefined`), which is the same signal `build-all` already uses to skip dependents.

`copyRuntimeAssets` globs `src/**/*.{json,d.ts,css,scss}` and writes each file under `lib/esm`, preserving the path relative to `src`. When `packagePublishesCjs` is true it also writes `lib/cjs`. The `linked build` step named "Copying files to lib folder" now calls the same function, so the two paths cannot drift.

`removeOldFiles` deletes `lib` files whose mtime is older than 120 seconds. A copied asset keeps the source file's age, so that sweep was deleting CSS and JSON that had just been copied from an older source. `runtimeSourceForLibFile` maps a `lib/esm` or `lib/cjs` path back to `src`. When that source file still exists, the sweep leaves the copy alone. Stale compiler output that has no source file is still deleted.

## Tests

`tests/unit/runtime-assets.test.ts`

- `copyRuntimeAssets` writes a CSS module next to the ESM output and does not create a CJS copy when the package does not publish CommonJS.
- `removeOldFiles` keeps a CSS file whose source still exists and deletes a stale `.js` file that has no source.

## Decisions

The copy stays after the package's own build script rather than replacing that script. Packages that already copy assets in their script copy them twice; the second copy is the same bytes. Packages that only run `tsc` now get the files.

A failed copy fails the build. The release reads these files from `lib` and has no later step that can invent them.

## Docs

`docs/architecture/vite-runtime-config.md` describes the Vite runtime, not this copy step, so it was left unchanged. Report 005 still stands: `build-all` invokes each package's build script and does not call `linked build`. This report adds the copy that runs after that script.

## Follow-up

None. The branch is `fix/copy-runtime-assets`.
