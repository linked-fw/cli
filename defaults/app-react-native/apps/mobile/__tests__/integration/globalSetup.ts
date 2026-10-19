/// <reference types="node" />
// Before the integration tests: check that the target is this repo's Compose Fuseki, reset the in-memory test
// dataset, start the API-only backend.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  API_PORT,
  API_URL,
  FUSEKI_DATASET,
  apiDir,
  describeComposePortFailure,
  repoRoot,
  resolveFusekiEnv,
} from './apiEnv';
import { answers, startApi } from './startApi';

/**
 * Refuses unless the target is safe to wipe: the dataset name ends in `-test`, and the Fuseki URL is on localhost at
 * the host port Docker Compose publishes for this repo's `fuseki` service (so never another project's Fuseki).
 */
function assertSafeTarget(baseUrl: string) {
  const target = `${baseUrl}/$/datasets/${FUSEKI_DATASET}`;
  const refuse = (reason: string): never => {
    throw new Error(`Refusing to reset ${target}: ${reason}`);
  };
  if (!FUSEKI_DATASET.endsWith('-test')) refuse('the dataset name does not end in "-test".');

  const url = new URL(baseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) refuse(`${url.hostname} is not localhost.`);
  const urlPort = url.port || (url.protocol === 'https:' ? '443' : '80');

  const compose = spawnSync('docker', ['compose', 'port', 'fuseki', '3030'], { cwd: repoRoot, encoding: 'utf8' });
  const composePort = compose.status === 0 ? /:(\d+)\s*$/.exec(compose.stdout.trim())?.[1] : undefined;
  if (!composePort) refuse(describeComposePortFailure(compose));
  if (composePort !== urlPort) {
    refuse(`port ${urlPort} is not the Compose Fuseki port ${composePort}. Set FUSEKI_PORT=${composePort}.`);
  }
}

export default async function globalSetup() {
  const fuseki = resolveFusekiEnv();

  // 1. Refuse a foreign target before anything is deleted.
  assertSafeTarget(fuseki.baseUrl);

  // 2. Fail fast when Fuseki is down. FUSEKI_BASE_URL is passed so the script does not read services/api/.env.
  const wait = spawnSync(process.execPath, [resolve(apiDir, 'scripts/wait-for-fuseki.mjs')], {
    env: { ...process.env, FUSEKI_BASE_URL: fuseki.baseUrl },
    encoding: 'utf8',
  });
  if (wait.status !== 0) throw new Error(wait.stderr.trim() || `wait-for-fuseki exited ${wait.status}`);

  if (await answers(API_URL)) {
    throw new Error(`Port ${API_PORT} is already in use; stop the process on it before running integration tests.`);
  }

  // 3. Reset: drop the dataset; the API's ensureDatasetExists() recreates it empty on boot.
  const auth = `Basic ${Buffer.from(`${fuseki.user}:${fuseki.password}`).toString('base64')}`;
  const del = await fetch(`${fuseki.baseUrl}/$/datasets/${FUSEKI_DATASET}`, {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  if (!del.ok && del.status !== 404) {
    throw new Error(`Deleting Fuseki dataset ${FUSEKI_DATASET} failed: ${del.status} ${await del.text()}`);
  }

  // 4. Start the API (startApi.ts); globalTeardown stops it.
  (globalThis as any).__LINKED_API__ = await startApi({ port: API_PORT, nodeEnv: 'development', fuseki });
}
