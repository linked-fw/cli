// Playwright config for @_linked/cli end-to-end tests.
//
// Both specs scaffold a fresh app to a tmpdir with this build and install this
// build into it (tests/e2e/helpers/app.ts; build first).
// - create-app.spec.ts spins up a Fuseki container via testcontainers, runs
//   `npm start` and drives a Person CRUD flow in the browser. Requires Docker.
// - dual-copy.spec.ts boots the app without Fuseki and reads only its output
//   (the dual-copy guard). No Docker, no browser; CI runs it
//   (.github/workflows/dual-copy-e2e.yml).
import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 5 * 60 * 1000, // 5 min — scaffold + install + Fuseki bootstrap is slow
  expect: {timeout: 15_000},
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
});
