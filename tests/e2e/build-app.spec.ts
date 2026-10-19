// End-to-end: `linked build-app` of a template app needs no data server and no
// Fuseki (cli report 020).
//
// The build resolves the `appAssets` file store before Vite runs. It loads the
// app's linked.backend.files.ts for that, not the storage file, which builds
// every dataset store and awaits a RemoteDataset's init() (a ping of its data
// server). The app's `appData` is a RemoteDataset at a dead url; the build must
// finish and write its release manifest. No Docker, no Fuseki, no browser, so
// CI runs this spec (.github/workflows/dual-copy-e2e.yml).
import {test, expect} from '@playwright/test';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {installApp, removeApp, scaffoldApp, type ScaffoldedApp} from './helpers/app.js';

// Nothing listens on port 9 (discard) on a dev machine or a CI runner.
const DEAD_URL = 'http://127.0.0.1:9';

let app: ScaffoldedApp | undefined;

test.describe.configure({timeout: 4 * 60 * 1000});

test.beforeAll(async () => {
  app = scaffoldApp('e2e-build-app');
  installApp(app);
}, /* timeout */ 6 * 60 * 1000);

test.afterAll(() => removeApp(app));

test('a RemoteDataset app builds with nothing listening on its url', () => {
  const dir = app!.dir;
  expect(
    existsSync(join(dir, 'linked.backend.files.ts')),
    'the template has no linked.backend.files.ts',
  ).toBe(true);
  const datasetsFile = join(dir, 'linked.backend.datasets.json');
  const config = JSON.parse(readFileSync(datasetsFile, 'utf8'));
  config.datasets.appData = {
    store: '@_linked/server/shapes/quadstores/RemoteDataset',
    config: {url: DEAD_URL, token: 'e2e-token'},
  };
  writeFileSync(datasetsFile, JSON.stringify(config, null, 2) + '\n');

  const result = spawnSync(
    'npm',
    ['run', 'build', '--', '--revision', 'e2e', '--allow-dirty'],
    {
      cwd: dir,
      env: {...process.env, FUSEKI_BASE_URL: DEAD_URL},
      encoding: 'utf8',
      timeout: 3 * 60 * 1000,
    },
  );
  const output = `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
  console.log(output);
  expect(output).not.toContain('Could not reach the data server');
  expect(output).toContain('Loading file storage from linked.backend.files.ts');
  expect(result.status, output).toBe(0);
  expect(existsSync(join(dir, 'public/bundles/linked-release.json')), output).toBe(true);
});
