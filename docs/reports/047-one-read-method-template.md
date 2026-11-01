---
date: 2026-11-01
summary: >
  Step X1 of core master plan 111 (one read method): the react-native template's nativeDefaults
  test stubs its store with readQuery, core's one read method (it replaced selectQuery and
  askQuery). The template's exact @_linked/core pin must move to the core minor with readQuery in
  the cli release. Patch.
packages: [cli]
---

# 047 — The react-native template stubs `readQuery`

Part of `@_linked/core` master plan 111; the cross-repo report is core report 113.

## PR

**What changed**

- `defaults/app-react-native/apps/mobile/__tests__/nativeDefaults.test.tsx`: the stub store answers
  `readQuery` (every read never settles while loading, rejects in error mode) instead of
  `selectQuery` and `askQuery`. The other members of the stub are unchanged.
- Changeset `one-read-method.md` (patch).

**Verification**

- `npm run test:unit` (built CLI), 1:14 min: `Test Suites: 103 passed, 103 total`,
  `Tests: 1267 passed, 1267 total`.
- `RUN_TEMPLATE_FULL=1 KEEP_TEMPLATE_FULL=1 npx jest --config jest.template.config.cjs tests/template/react-native.full.test.ts`,
  129 s: `Tests: 1 failed, 9 passed, 10 total`. The one failure is `npm test passes`: the scaffold
  installs the pinned `@_linked/core` 2.43.0, which still calls `selectQuery`, so the loading
  component shows `linked-error` instead of `linked-loader`. Expected until the pin moves.
- The kept scaffold with the new core's `lib` (master `one-read-method`) copied over its
  `node_modules/@_linked/core`: `npx jest` in `apps/mobile` → `Test Suites: 6 passed, 6 total`,
  `Tests: 24 passed, 24 total` (both `nativeDefaults` tests pass).
- `grep -rnwE 'selectQuery|askQuery|triplesQuery|triplesTermsQuery' src test tests defaults README.md docs/architecture`
  → no hits.

**Deviations from the plan**

- Plan 111's Verify named `jest.config.cjs` for the template suite; it has its own config
  (`jest.template.config.cjs`) and is gated by `RUN_TEMPLATE_FULL=1`. Plan corrected.

**Follow-ups**

- The release PR of this patch moves the template's `@_linked/core` pin (`2.43.0` in
  `apps/mobile`, `packages/app-shapes`, `services/api`) to the core minor that ships `readQuery`;
  recorded in plan 111's release order.
