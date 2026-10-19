// End-to-end: a template app run by this CLI build loads one copy of each
// framework package under `linked start` (cli reports 015 to 017).
//
// Scaffolds an app from the template with the local build, installs this
// build into it (helpers/app.ts, E2E_CLI to pick another) and boots it twice:
// on its committed FusekiStore with nothing answering, and with `appData` a
// RemoteDataset at a dead url. Each boot must print the guard's `on` line and
// no `TWO COPIES` line. Then the browser side (report 021): with
// `@_linked/shape-ui` installed (it ships `src/` with `.tsx` imported from `.ts`
// and `.tsx`), headless Chromium loads `/` and no `@_linked/*` script module may
// be requested in two forms (plain and `?v=`, two paths, or the optimizer and
// its files). No Docker and no Fuseki, so CI runs this spec
// (.github/workflows/dual-copy-e2e.yml).
import {test, expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {linkedModuleCopies} from './helpers/moduleCopies.js';
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

// The files the RemoteDataset test rewrites, as the template has them.
const pristine: Record<string, string> = {};

test.beforeAll(async () => {
  app = scaffoldApp('e2e-dual-copy');
  installApp(app);
  for (const file of ['linked.backend.datasets.json', 'linked.backend.storage.ts']) {
    pristine[file] = readFileSync(join(app.dir, file), 'utf8');
  }
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

// shape-ui's `src/hostContext.tsx` is imported from `.ts` and `.tsx` files; on
// cli 1.51.0 the browser requested it plain and as `?v=<hash>`, two React
// contexts (report 018). The latest shape-ui by default, so a new `src/` layout
// is seen; E2E_SHAPE_UI pins one (e.g. 2.8.0, the version report 018 measured).
test('the browser loads one copy of each @_linked module, with a package that ships src/', async ({
  page,
}) => {
  const dir = app!.dir;
  for (const [file, text] of Object.entries(pristine)) writeFileSync(join(dir, file), text);
  const shapeUi = `@_linked/shape-ui@${process.env.E2E_SHAPE_UI || 'latest'}`;
  execFileSync('npm', ['install', '--no-audit', '--no-fund', shapeUi], {
    cwd: dir,
    stdio: 'inherit',
  });
  const appFile = join(dir, 'src/App.tsx');
  writeFileSync(
    appFile,
    "import '@_linked/shape-ui';\nimport '@_linked/shape-ui/components/InstanceView';\n" +
      readFileSync(appFile, 'utf8'),
  );

  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  let run: AppRun | undefined;
  try {
    run = startApp(app!, bootEnv());
    const status = await waitForHttp(`${ORIGIN}/`, run, 150_000);
    expect(status, run.output()).not.toBe(0);
    await page.goto(`${ORIGIN}/`, {waitUntil: 'networkidle', timeout: 120_000});

    const shapeUiSource = urls.filter((url) => url.includes('/@_linked/shape-ui/src/'));
    console.log(
      `[e2e] ${urls.length} requests, ${shapeUiSource.length} from shape-ui's src/ (${shapeUi})`,
    );
    expect(
      shapeUiSource.length,
      "the page loaded nothing from shape-ui's src/: the check has nothing to look at",
    ).toBeGreaterThan(0);
    const copies = linkedModuleCopies(urls);
    expect(
      copies,
      `${copies.length} @_linked module(s) loaded in more than one form:\n` +
        copies.map((c) => `${c.module}\n  ${c.urls.join('\n  ')}`).join('\n'),
    ).toEqual([]);
    expectOneCopy(run.output());
  } finally {
    await stopApp(run);
  }
});
