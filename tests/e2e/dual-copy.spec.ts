// End-to-end: a template app run by this CLI build loads one copy of each
// framework package under `linked start` (cli reports 015 to 017).
//
// Scaffolds an app from the template with the local build, installs this
// build into it (helpers/app.ts, E2E_CLI to pick another) and boots it twice:
// on its committed FusekiStore with nothing answering, and with `appData` a
// RemoteDataset at a dead url. Each boot must print the guard's `on` line and
// no `TWO COPIES` line. No Docker, no Fuseki and no browser: only the boot's
// output is read, so CI runs this spec (.github/workflows/dual-copy-e2e.yml).
import {test, expect} from '@playwright/test';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  GUARD_ON,
  exited,
  guardLines,
  installApp,
  removeApp,
  scaffoldApp,
  startApp,
  stopApp,
  waitForHttp,
  type AppRun,
  type ScaffoldedApp,
} from './helpers/app.js';

// Nothing listens on port 9 (discard) on a dev machine or a CI runner.
const DEAD_URL = 'http://127.0.0.1:9';
const APP_PORT = 4500 + (process.pid % 100);
const ORIGIN = `http://localhost:${APP_PORT}`;

let app: ScaffoldedApp | undefined;

// Not serial: a failing boot must not hide the other one's result. The two tests
// run in file order on one worker (the RemoteDataset one rewrites the app).
test.describe.configure({timeout: 4 * 60 * 1000});

test.beforeAll(async () => {
  app = scaffoldApp('e2e-dual-copy');
  installApp(app);
}, /* timeout */ 6 * 60 * 1000);

test.afterAll(() => removeApp(app));

function bootEnv(): Record<string, string> {
  return {
    NODE_ENV: 'development',
    PORT: String(APP_PORT),
    SITE_ROOT: ORIGIN,
    DATA_ROOT: `${ORIGIN}/data`,
    // The committed FusekiStore points here; nothing answers, so no dataset is
    // created anywhere.
    FUSEKI_BASE_URL: DEAD_URL,
    FUSEKI_DATASET: 'e2e-dual-copy',
    LINKED_DUAL_COPY_GUARD: '1',
  };
}

function expectOneCopy(output: string) {
  const {status, twoCopies} = guardLines(output);
  expect(status, output).toEqual([GUARD_ON]);
  expect(twoCopies, `${twoCopies.length} TWO COPIES line(s):\n${twoCopies.join('\n')}`).toEqual(
    [],
  );
}

test('the committed FusekiStore app boots and renders / with one copy of each package', async () => {
  let run: AppRun | undefined;
  try {
    run = startApp(app!, bootEnv());
    // Any answer: with no Fuseki the People example's query fails, but the
    // render still imports every module the page needs.
    const status = await waitForHttp(`${ORIGIN}/`, run, 150_000);
    expect(status, run.output()).not.toBe(0);
    expect(run.output()).toContain('[storage] appData: FusekiStore');
    // `/src/index.tsx` is what the browser loads first; serving it transforms
    // the client entry as well.
    await waitForHttp(`${ORIGIN}/src/index.tsx`, run, 30_000);
    expectOneCopy(run.output());
  } finally {
    await stopApp(run);
  }
});

test('a RemoteDataset appData is the class the app imports, and so is its error', async () => {
  const dir = app!.dir;
  const datasetsFile = join(dir, 'linked.backend.datasets.json');
  const config = JSON.parse(readFileSync(datasetsFile, 'utf8'));
  config.datasets.appData = {
    store: '@_linked/server/shapes/quadstores/RemoteDataset',
    config: {url: DEAD_URL, token: 'e2e-token'},
  };
  writeFileSync(datasetsFile, JSON.stringify(config, null, 2) + '\n');

  // The probe runs before the template's own init(): that one exits the boot
  // with its message. A failed init() is not memoized, so both ping.
  const storageFile = join(dir, 'linked.backend.storage.ts');
  const storage = readFileSync(storageFile, 'utf8');
  const marker = 'if (appData.init) {';
  expect(storage, 'the template storage file changed shape').toContain(marker);
  const probe = [
    "console.log('[probe] appData instanceof RemoteDataset:', appData instanceof RemoteDataset);",
    'try {',
    '  await appData.init?.();',
    "  console.log('[probe] init() did not throw');",
    '} catch (err) {',
    '  console.log(',
    "    '[probe] init() error instanceof RemoteDatasetUnreachableError:',",
    '    err instanceof RemoteDatasetUnreachableError,',
    '  );',
    '}',
    '',
  ].join('\n');
  writeFileSync(
    storageFile,
    "import { RemoteDatasetUnreachableError } from '@_linked/server/shapes/quadstores/RemoteDataset';\n" +
      storage.replace(marker, probe + marker),
  );

  const run = startApp(app!, bootEnv());
  try {
    const code = await Promise.race([
      exited(run.child),
      new Promise<'timeout'>((done) => setTimeout(() => done('timeout'), 150_000)),
    ]);
    const output = run.output();
    expect(code, output).not.toBe('timeout');
    expect(code, output).not.toBe(0);
    expect(output).toContain('[probe] appData instanceof RemoteDataset: true');
    expect(output).toContain(
      '[probe] init() error instanceof RemoteDatasetUnreachableError: true',
    );
    expect(output).toContain(`Could not reach the data server at ${DEAD_URL}`);
    // The template's message, not the error's stack.
    expect(output).not.toMatch(/RemoteDatasetUnreachableError[^\n]*\n\s+at /);
    expectOneCopy(output);
  } finally {
    await stopApp(run);
  }
});
