// End-to-end: scaffold a Linked app via `linked create-app`, install, start it
// against a fresh Fuseki container, then drive the Person CRUD flow.
//
// Self-contained: scaffolds into an OS tmpdir, installs deps from npm,
// starts a Fuseki testcontainer, exercises the Person fixture. No
// dependency on any parent monorepo. Companion `@_linked/*` packages
// must be published to npm at compatible versions; if they aren't yet,
// set SKIP_E2E=1 to skip this test.
import {test, expect} from '@playwright/test';
import {GenericContainer, Wait, StartedTestContainer} from 'testcontainers';
import {spawn, ChildProcess, execSync} from 'node:child_process';
import {rmSync, existsSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_LAUNCH = resolve(__dirname, '../../lib/esm/launch.js');

// Deterministic-enough app name; salted so concurrent runs don't collide.
const APP_NAME = `e2e-test-app-${process.pid}`;
const SCAFFOLD_ROOT = mkdtempSync(join(tmpdir(), 'linked-cli-e2e-'));
const APP_DIR = join(SCAFFOLD_ROOT, APP_NAME);
const DATASET = `${APP_NAME}-main`;
const APP_PORT = 4400 + (process.pid % 100); // avoid collision with a CN backend on 4040

let fuseki: StartedTestContainer;
let appProc: ChildProcess | null = null;
let fusekiUrl: string;

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

  // 2. Scaffold the app via the local CLI build.
  if (existsSync(APP_DIR)) rmSync(APP_DIR, {recursive: true, force: true});
  execSync(
    `node ${CLI_LAUNCH} create-app ${APP_NAME} --app-name "E2E" --app-prefix e2e --app-domain e2e.local --skip-install`,
    {cwd: SCAFFOLD_ROOT, stdio: 'inherit'},
  );

  // 3. Create the matching dataset in Fuseki. Template default is
  // `${hyphen_name}-main` → matches DATASET above.
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

  // 4. Install scaffolded app deps from npm. The scaffolded package.json
  // pins @_linked/* versions; install resolves them straight from the
  // registry (no workspace symlinks involved).
  execSync('npm install', {cwd: APP_DIR, stdio: 'inherit'});

  // 5. Boot the app with env overrides pointing at the testcontainer Fuseki.
  appProc = spawn('npm', ['start'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      FUSEKI_BASE_URL: fusekiUrl,
      FUSEKI_DATASET: DATASET,
      PORT: String(APP_PORT),
    },
    stdio: 'inherit',
  });

  // 6. Wait for HTTP 200 on /.
  await waitForServer(`http://localhost:${APP_PORT}/`, 90_000);
}, /* timeout */ 4 * 60 * 1000);

test.afterAll(async () => {
  // Kill the app server.
  if (appProc) {
    appProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    if (!appProc.killed) appProc.kill('SIGKILL');
  }

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
  if (existsSync(SCAFFOLD_ROOT)) {
    rmSync(SCAFFOLD_ROOT, {recursive: true, force: true});
  }
}, /* timeout */ 2 * 60 * 1000);

test('Person fixture: add → edit → delete round-trip', async ({page}) => {
  await page.goto(`http://localhost:${APP_PORT}/`);
  await expect(page.getByTestId('person-overview')).toBeVisible();

  // Add Alice
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

  // Delete — row disappears
  await page.getByRole('button', {name: 'Delete'}).first().click();
  await expect(
    page.getByTestId('person-name').filter({hasText: 'Alicia Anderson'}),
  ).toBeHidden();
});

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
