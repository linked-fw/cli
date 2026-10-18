// End-to-end: scaffold a Linked app via `linked create-app`, install, start it
// against a fresh Fuseki container, then drive the Person CRUD flow.
//
// Self-contained: scaffolds into an OS tmpdir, installs deps from npm,
// starts a Fuseki testcontainer, exercises the Person fixture. No
// dependency on any parent monorepo. Companion `@_linked/*` packages
// must be published to npm at compatible versions; if they aren't yet,
// set SKIP_E2E=1 to skip this test.
//
// The app runs this CLI build, not npm's (helpers/app.ts, E2E_CLI to pick
// another), and the round-trip fails on a missing `dual-copy guard: on` line
// or any `TWO COPIES` line. tests/e2e/dual-copy.spec.ts checks the same
// without Docker.
import {test, expect, type Locator} from '@playwright/test';
import {GenericContainer, Wait, StartedTestContainer} from 'testcontainers';
import {
  GUARD_ON,
  guardLines,
  installApp,
  removeApp,
  scaffoldApp,
  startApp,
  stopApp,
  type AppRun,
  type ScaffoldedApp,
} from './helpers/app.js';

const APP_PORT = 4400 + (process.pid % 100); // avoid collision with a CN backend on 4040

let fuseki: StartedTestContainer;
let app: ScaffoldedApp | undefined;
let appRun: AppRun | undefined;
let fusekiUrl: string;
let DATASET: string;

test.beforeAll(async () => {
  if (process.env.SKIP_E2E === '1') test.skip();

  // 1. Start a fresh Fuseki container with a random host port.
  fuseki = await new GenericContainer('stain/jena-fuseki')
    .withExposedPorts(3030)
    .withEnvironment({ADMIN_PASSWORD: 'admin'})
    // Ready when Fuseki answers its own health endpoint, not when a log line matches: the
    // startup message has changed wording between image versions and silently broke the wait.
    .withWaitStrategy(Wait.forHttp('/$/ping', 3030).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  fusekiUrl = `http://${fuseki.getHost()}:${fuseki.getMappedPort(3030)}`;

  // 2. Scaffold the app via the local CLI build (app name salted with the pid
  // so concurrent runs don't collide).
  app = scaffoldApp('e2e-test-app');
  DATASET = `${app.name}-main`;

  // 3. Create the dataset the app is pointed at below.
  const adminAuth = Buffer.from('admin:admin').toString('base64');
  const resp = await fetch(`${fusekiUrl}/$/datasets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${adminAuth}`,
    },
    body: `dbName=${DATASET}&dbType=mem`,
  });
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Failed to create dataset: ${resp.status} ${await resp.text()}`);
  }

  // 4. Install scaffolded app deps from npm (the template's lockfile), then
  // this CLI build on top: `npm start` runs the app's installed CLI.
  installApp(app);

  // 5. Boot the app with env overrides pointing at the testcontainer Fuseki.
  // The scaffolded `.env` pins PORT=4000 together with SITE_ROOT/DATA_ROOT on
  // :4000. SITE_ROOT is inlined into the browser bundle as the backend every
  // `Server.call` targets, so moving PORT alone leaves the page posting its
  // queries to :4000 — nothing answers, and the Add form fails silently. The
  // three move together, as they must for any host that injects PORT.
  const appOrigin = `http://localhost:${APP_PORT}`;
  appRun = startApp(app, {
    FUSEKI_BASE_URL: fusekiUrl,
    FUSEKI_DATASET: DATASET,
    PORT: String(APP_PORT),
    SITE_ROOT: appOrigin,
    DATA_ROOT: `${appOrigin}/data`,
  });

  // 6. Wait for HTTP 200 on /.
  await waitForServer(`${appOrigin}/`, 90_000);
}, /* timeout */ 4 * 60 * 1000);

test.afterAll(async () => {
  // Stop the app server (its whole process group).
  await stopApp(appRun);

  // Drop the Fuseki dataset (idempotent).
  try {
    const adminAuth = Buffer.from('admin:admin').toString('base64');
    await fetch(`${fusekiUrl}/$/datasets/${DATASET}`, {
      method: 'DELETE',
      headers: {Authorization: `Basic ${adminAuth}`},
    });
  } catch {
    // Container may be gone already; ignore.
  }

  // Stop testcontainer.
  await fuseki?.stop().catch(() => {});

  // Remove scaffolded app folder + its parent tmpdir.
  removeApp(app);
}, /* timeout */ 2 * 60 * 1000);

test('Person fixture: add → edit → delete round-trip', async ({page}) => {
  await page.goto(`http://localhost:${APP_PORT}/`);
  await expect(page.getByTestId('person-overview')).toBeVisible();

  // Add Alice. The page is server-rendered, so the form is visible before React
  // has hydrated it; clicking Add then is a native GET submit that reloads the page
  // and drops the input. Wait for React to own the button first.
  await waitForHydration(page.getByRole('button', {name: 'Add'}));
  await page.getByPlaceholder('First name').fill('Alice');
  await page.getByPlaceholder('Last name').fill('Anderson');
  await page.getByRole('button', {name: 'Add'}).click();
  await expect(page.getByTestId('person-name').filter({hasText: 'Alice Anderson'})).toBeVisible();

  // Edit to Alicia
  await page.getByRole('button', {name: 'Edit'}).first().click();
  const editRow = page.getByTestId('person-edit').first();
  await editRow.getByLabel('First name').fill('Alicia');
  await editRow.getByRole('button', {name: 'Save'}).click();
  await expect(
    page.getByTestId('person-name').filter({hasText: 'Alicia Anderson'}),
  ).toBeVisible();

  // Reload — change must persist
  await page.reload();
  await expect(
    page.getByTestId('person-name').filter({hasText: 'Alicia Anderson'}),
  ).toBeVisible();

  // Delete — row disappears. Same as Add: the reloaded row is server-rendered, and
  // a click before hydration reaches no handler.
  const deleteButton = page.getByRole('button', {name: 'Delete'}).first();
  await waitForHydration(deleteButton);
  await deleteButton.click();
  await expect(
    page.getByTestId('person-name').filter({hasText: 'Alicia Anderson'}),
  ).toBeHidden();

  // One copy of each framework package through the whole round-trip.
  const {status, twoCopies} = guardLines(appRun!.output());
  expect(status, appRun!.output()).toEqual([GUARD_ON]);
  expect(twoCopies, `${twoCopies.length} TWO COPIES line(s):\n${twoCopies.join('\n')}`).toEqual(
    [],
  );
});

/**
 * Wait until React has hydrated the element: React attaches its props, event
 * handlers included, to a hydrated DOM node under a `__reactProps$<id>` key.
 * Visibility is no signal — server-rendered markup is visible before any of it
 * is interactive.
 */
async function waitForHydration(locator: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps$'))),
      {message: 'element was never hydrated by React', timeout: 30_000},
    )
    .toBe(true);
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, {method: 'GET'});
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms`);
}
