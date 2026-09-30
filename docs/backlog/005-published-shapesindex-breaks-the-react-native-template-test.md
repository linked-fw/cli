---
summary: >
  `tests/template/react-native.full.test.ts` fails on `main`. The scaffold it builds installs
  `@_linked/cli` from the registry, and the published
  `lib/esm/utils/shapesIndex.js` line 12 is `import {minimatch} from 'minimatch'` — a named
  import the resolved CJS `minimatch` does not provide, so `linked build` inside the scaffold
  dies with a `SyntaxError` before it compiles anything. Source and published build agree
  (`src/utils/shapesIndex.ts:3` is the same import), so this is not a stale artifact.
status: Open
---

# 005 — the published `shapesIndex.js` breaks the react-native template test

## The failure

`tests/template/react-native.full.test.ts` fails on `main`. The test scaffolds a react-native app
and runs `linked build` in it. The scaffold does **not** use the workspace CLI — it installs
`@_linked/cli` from the registry, so the failure is in the published artifact.

## What is in the published file

```
$ grep -n minimatch node_modules/@_linked/cli/lib/esm/utils/shapesIndex.js
12:import { minimatch } from 'minimatch';
157:    return minimatch(file, p, { dot: true });
```

(measured against `@_linked/cli@1.33.2`, the version a CN install resolves today)

The same import is in source, so the published build is faithful, not stale:

```
$ grep -n minimatch src/utils/shapesIndex.ts
3:import {minimatch} from 'minimatch';
179:  return minimatch(file, p, {dot: true});
```

`minimatch` is declared as `^9.0.4` in the CLI's own `dependencies`. In the scaffold's install the
named ESM import off that CJS module does not resolve, and node throws a `SyntaxError` during
`linked build`.

## Notes for whoever fixes it

- The mechanism (CJS named-export detection) should be **re-measured inside a scaffold** before
  the fix is chosen — the exact `minimatch` version a fresh scaffold resolves is what decides it,
  and it is not necessarily the one a CN install hoists (CN currently hoists `minimatch@10.2.6`,
  which declares `"type": "module"` but whose `main` still points at `dist/commonjs/index.js`).
- The robust fix is a default import plus a property read, or `createRequire`, rather than
  pinning a `minimatch` version — the module's export shape has changed across its majors and
  will again.
- Whatever the fix, the check that matters is the template test going green with the CLI
  **installed from the registry**, not with the workspace copy linked in. This bug is invisible
  to a workspace-linked run.
