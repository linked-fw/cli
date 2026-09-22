---
summary: Two bugs in createViteConfig's manualChunks, found the same way and fixed the same way —
  a chunk grouping that split modules which must initialise together, producing a cycle Rollup
  resolved by running the wrong half first. Records both, why a wrong grouping is invisible until
  the bundle runs, and the invariant that replaces guesswork.
---

# Chunk cycles in `manualChunks`

Two defects, months apart in origin and identical in shape. Both produced a bundle that built
cleanly, passed every test, and threw before rendering a single frame.

## The shape of the bug

`manualChunks` assigns each module to a named chunk. If two chunks end up importing each other,
Rollup must pick an execution order — and if the chunk it runs first reads a binding from the other
at module scope, that binding is still uninitialised.

The symptom is a `ReferenceError` deep inside minified vendor code, naming a variable that exists
nowhere in the source.

## 1. `react-router` split from React — [#102](https://github.com/linked-fw/cli/pull/102)

`react-router-dom` was grouped into `react-vendor`; `react-router`, which it re-exports, was left in
the catch-all `vendor`. `vendor` also calls `React.createContext(...)` at module scope, so:

```
react-vendor ──imports──> vendor        (react-router-dom re-exports react-router)
vendor       ──imports──> react-vendor  (createContext at module scope)
```

Rollup ran `vendor` first:

```
TypeError: Cannot read properties of undefined (reading 'createContext')
```

`@remix-run/router` joins them for the same reason.

## 2. Registry-installed framework code split from workspace copies — [#115](https://github.com/linked-fw/cli/pull/115)

`@_linked/*` went into the `linked` chunk only when the module resolved to a **workspace** path
(`/packages/<name>/`). An application can hold both kinds at once — a published `@_linked/server`
in `node_modules` beside a workspace `@_linked/core` — and the published copy fell through to
`vendor`. The two halves of the framework then imported each other:

```
ReferenceError: Cannot access 'Wo' before initialization
    at qb (assets/linked-fad669a1.js:6:1133)
    at assets/vendor-46c2cc5f.js:1:102344
```

`node_modules/@_linked/*` and `node_modules/lincd-*` now join the workspace copies in `linked`.

## Why neither was caught earlier

**A wrong grouping is not a build error.** Rollup is doing exactly what it was told; the output is
valid JavaScript that loads in the right order for some other arrangement of the same modules. It
can only be observed by running the bundle in a browser, which no test here does.

It is also **installation-dependent**. The second bug only appears in an application that has both
a workspace and a registry copy of the same scope — a perfectly ordinary state that no fixture
reproduces.

Both were found the same way: building a real consuming application and opening it.

## The invariant

> **Modules that must initialise together belong in the same chunk.**

Concretely, for a group that shares a chunk, every module the group re-exports or transitively
depends on at module scope belongs with it. Splitting a package from its own re-exports, or a
framework from a second copy of itself, is what creates the cycle.

## What replaced the guesswork

The routing is now an exported pure function, `chunkForModuleId(id)`, covered by
`tests/unit/manualChunks.test.ts`. The tests assert group membership directly — that React,
`react-dom`, `react-router`, `react-router-dom`, `@remix-run/router` and `scheduler` share a chunk;
that a registry-installed `@_linked/server` and a `lincd-*` package land with the workspace copies;
that unrelated dependencies still reach the catch-all; and that app source is left to Rollup.

That does not prove the absence of cycles — nothing short of running the bundle does — but it names
the invariant, so the next person changing the grouping has to state what they believe rather than
discover it in a browser.

## If it happens again

A `ReferenceError` for an undefined or uninitialised binding, thrown from a vendor chunk at load:

```bash
# which chunks import each other
grep -oE 'from"\./[a-z-]+-[a-z0-9]+\.js"' public/bundles/assets/vendor-*.js | sort -u
grep -oE 'from"\./[a-z-]+-[a-z0-9]+\.js"' public/bundles/assets/linked-*.js  | sort -u
```

Two chunks naming each other is the cycle. Then find which package sits on the wrong side, and move
it to join the group it initialises with.
