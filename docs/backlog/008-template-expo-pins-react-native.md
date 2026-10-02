---
summary: >
  Template: let the Expo SDK pin react-native. `defaults/app-react-native` was getting standalone
  `react-native` / `@react-native/*` bumps from Renovate (cli#183, cli#167, both to 0.87.1). Expo
  pins React Native exactly per SDK -- 57 is 0.86.3, 58 is 0.88 -- and no Expo SDK will ever
  support 0.87, so those bumps break `linked create-app --template react-native` while CI stays
  green. React Native and React are now held in the shared Renovate preset; they move only with an
  Expo SDK upgrade (`npx expo install --fix`). Next step is SDK 58.
status: Open -- the hold is in place; the SDK 58 move is the follow-up. Replaces Renovate PRs cli#183 and cli#167
---

# 008 — Template: let the Expo SDK pin react-native

## The problem

The react-native template (`defaults/app-react-native/`) is an Expo app. Expo pins React Native
**exactly** per SDK: SDK 57 is `react-native` 0.86.3, SDK 58 is 0.88. There is no SDK for 0.87 and
there never will be. Renovate treats `react-native` and `@react-native/*` as ordinary
dependencies, so it opened:

- [#183](https://github.com/linked-fw/cli/pull/183) — `react-native` to 0.87.1
- [#167](https://github.com/linked-fw/cli/pull/167) — `@react-native/jest-preset` to 0.87.1

Both break `linked create-app --template react-native`:

- **Both together:** `ERESOLVE`, because `jest-expo` 57 peers on `@react-native/jest-preset ^0.86.3`.
- **#183 alone:** installs, but `jest-expo` cannot find `@react-native/assets-registry/registry`,
  and `expo export` cannot find `react-native/rn-get-polyfills`.

CI passed both, because `pr.yml` runs `test:unit` only, and the full template test
(`npm run test:template`, `RUN_TEMPLATE_FULL=1`) does not run in CI.

## What is in place now

The shared preset ([`linked-fw/renovate-config`](https://github.com/linked-fw/renovate-config))
scopes three rules to this repo and `defaults/app-react-native/**`:

1. `react-native`, `@react-native/**`, `react`, `react-dom` and `@types/react` are **disabled for
   every update type**. React is pinned by the SDK too, and the template's
   `scripts/check-react.mjs` asserts one exact React (`EXPECTED_VERSION = '19.2.3'`).
2. The Expo SDK packages (`expo`, `expo-*`, `@expo/**`, `jest-expo`, `eslint-config-expo`) are
   **grouped**, so patch releases within SDK 57 arrive as one PR.
3. Their **majors** (a new SDK) are disabled. A new SDK has to move `react-native` and `react` as
   well, and rule 1 holds those.

Security fixes still come through. The preset sets `vulnerabilityAlerts.enabled: true`, which
overrides an `enabled: false` packageRule.

## Next step: SDK 58

Move the template to SDK 58 — React Native 0.88 and React 19.3 — **once `expo@58` is the npm
`latest` tag and has had a few patches**. On 2026-10-02, `latest` is `57.0.26` and 58 is on `next`
(`58.0.2`).

Do it by hand: `npx expo install expo@^58 && npx expo install --fix` in `apps/mobile`, then check:

- **`jest-expo` 58 peer dependencies.** It peers on `@react-native/jest-preset ^0.88.0-rc.3` and
  `react-server-dom-webpack ~19.0.4 || ~19.1.5 || ~19.2.4 || ~19.3.0`. Set
  `@react-native/jest-preset` to the 0.88 that SDK 58 pins.
- **`eslint-config-expo` 58** at the template root (58.0.x exists). Keep it on the same SDK
  number as `expo`.
- **iOS SwiftPM.** Recent Expo and React Native releases move iOS dependencies towards Swift
  Package Manager. Check that `expo run:ios` and the generated iOS project still build from a
  fresh scaffold.
- **The `check:react` assertion.** Bump `EXPECTED_VERSION` in `scripts/check-react.mjs` to the
  React 19.3 that SDK 58 pins, and `react-dom` in `services/api` with it. Then confirm that
  `@_linked/react` and `react-native` still resolve that same single file.
- `npm run test:template` green, against a CLI **installed from the registry** (see below).

Then change nothing in the Renovate rules. They hold React Native at whatever version the SDK
pinned.

## Suggestion: run the template test in CI for template changes

These bumps got through because nothing in CI builds the template. A path-filtered job that runs
`npm run test:template` when `defaults/app-react-native/**` (or the scaffolding code) changes would
have failed both PRs. It is slow, because it installs a whole Expo app, so path-filtering it is
what makes it affordable.

## Known: the shapes-build template test is already red on main

Before this can be a CI gate, the existing failure has to go. The shapes-build step fails with
minimatch's "does not provide an export named 'minimatch'". The cause is in the harness: it copies
the **current** CLI `lib/` over a scaffold whose packages pin `@_linked/cli` **1.13.0**
(`overlayLib` in `tests/template/react-native.full.test.ts`; the pin is in
`packages/app-shapes/package.json` and `services/api/package.json`). So the new code runs against
the old CLI's dependency tree. See also
[005](./005-published-shapesindex-breaks-the-react-native-template-test.md), which records the
same symptom from the published-artifact side.
