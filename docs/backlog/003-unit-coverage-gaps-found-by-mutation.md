---
summary: >
  Two places where the unit suite stays green under a mutation that should break it, found while
  falsifying the suites revived by backlog 002. Neither is a defect; both are holes in the
  evidence.
---

# 003 — Unit coverage gaps found by mutation

Found by mutation-testing every suite revived in
[002](002-jest-cannot-resolve-linked-packages.md): each fix was reverted in source and the suite
re-run. All seven revived suites went **RED**, so none is inert. These two mutations stayed
**GREEN**, which means nothing asserts the behaviour:

1. **`planReleasePublish`'s `totalBytes`.** Replacing the reduce with `0` does not fail any test —
   the release plan's total byte count is never asserted.
2. **The default `buildFrontend` implementation.** The `buildApp` tests *inject* `buildFrontend`,
   so the default that actually calls vite's `build()` is never exercised. Mutating the caller
   (`buildFrontend(appRoot, baseURL)`) does go red, so the base URL *computation* is covered; the
   handoff into vite is not.

## One near-miss worth keeping

`stripYarnProjectFiles` looked inert when mutated against the `createApp.reactNative` suite alone
(GREEN), but the same mutation run against the **whole** unit suite went RED in
`packageSetup.test.ts`. It is covered — by a different suite.

So: **mutate against the full run, not the suite you think owns the code.** A per-suite green is
not evidence that nothing covers the behaviour.

## Not covered at all by that work

`npm test` also runs `test:e2e` (Playwright, `tests/e2e/`, testcontainers). That half was neither
run nor falsified; its scope was the jest configuration. If the same evidence is wanted for the
e2e suite, it needs its own item.
