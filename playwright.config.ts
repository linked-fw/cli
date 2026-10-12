// Playwright config for @_linked/cli end-to-end tests.
//
// The spec scaffolds a fresh app to a tmpdir, spins up a Fuseki container via
// testcontainers, runs `npm install` and `npm start` against the scaffolded
// app, then drives a Person CRUD flow in the browser. See
// tests/e2e/create-app.spec.ts for the per-test setup.
//
// Requires Docker to be available locally / in CI.
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
