/// <reference types="node" />
// Starts the API-only backend (`linked start --api-only` in services/api) for the integration tests: globalSetup
// starts the development API every test uses, and productionWrites.test.ts starts a second one with
// NODE_ENV=production.
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { FUSEKI_DATASET, type FusekiEnv, apiDir, readApiEnvFile, repoRoot } from './apiEnv';

// The variables that select S3FileStore (services/api/src/fileStoreEnv.ts); blanked even when unset anywhere.
const S3_ENV_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET_ENDPOINT', 'S3_FILES_BUCKET_NAME'];

export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

/** Kills the API's whole process group; safe to call repeatedly and after it exited. */
function killGroup(api: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (!api.pid) return;
  try {
    process.kill(-api.pid, signal);
  } catch {
    // Already gone.
  }
}

export type StartedApi = { api: ChildProcess; stop: () => void; killGroup: (signal: NodeJS.Signals) => void };

/**
 * Starts the API on `port` against `fuseki` and the test dataset, and resolves once it answers HTTP. Throws (after
 * stopping it) when it exits first or does not answer in time.
 */
export async function startApi({
  port,
  nodeEnv,
  fuseki,
}: {
  port: number;
  nodeEnv: 'development' | 'production';
  fuseki: FusekiEnv;
}): Promise<StartedApi> {
  const url = `http://localhost:${port}`;
  // Test hooks: INTEGRATION_API_BIN replaces `linked` (e.g. with a process that never answers) and
  // INTEGRATION_API_TIMEOUT_MS shortens the wait, to exercise the failure cleanup.
  const apiBin = process.env.INTEGRATION_API_BIN || resolve(repoRoot, 'node_modules/.bin/linked');
  const startTimeoutMs = Number(process.env.INTEGRATION_API_TIMEOUT_MS) || 60_000;

  if (await answers(url)) {
    throw new Error(`Port ${port} is already in use; stop the process on it before running integration tests.`);
  }

  // Every Fuseki variable is explicit, and the S3 ones are blanked, so nothing is taken from services/api/.env
  // (`linked start` does not override variables that are already set, even when empty).
  const env: NodeJS.ProcessEnv = { ...process.env };
  const s3Keys = [...Object.keys(process.env), ...Object.keys(readApiEnvFile()), ...S3_ENV_KEYS];
  for (const key of s3Keys) if (/^(AWS|S3)_/.test(key)) env[key] = '';
  // Except AWS_REGION: @_linked/s3 builds a client at import with `AWS_REGION ?? 'us-east-1'`, and an empty region
  // throws "Region is missing". Removed instead; the blank S3_FILES_BUCKET_NAME already rules out S3FileStore.
  delete env.AWS_REGION;
  Object.assign(env, {
    NODE_ENV: nodeEnv,
    PORT: String(port),
    SITE_ROOT: url,
    DATA_ROOT: `${url}/data`,
    FUSEKI_BASE_URL: fuseki.baseUrl,
    FUSEKI_USER: fuseki.user,
    FUSEKI_PASSWORD: fuseki.password,
    FUSEKI_DATASET,
    FUSEKI_DB_TYPE: 'mem',
  });

  let output = '';
  const api = spawn(apiBin, ['start', '--api-only'], {
    cwd: apiDir,
    env,
    // `linked start` spawns its own children (Vite, the server). `detached` gives the CLI its own process group, so
    // one `kill(-pid)` stops all of them; killing only the CLI's PID would leave the server listening on the port.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout?.on('data', (d) => (output += d));
  api.stderr?.on('data', (d) => (output += d));
  let exited: number | null = null;
  api.on('exit', (code) => (exited = code ?? -1));

  // A detached group outlives Jest unless it is killed: on exit, Ctrl+C and SIGTERM too, not only in teardown.
  const onExit = () => killGroup(api, 'SIGKILL');
  const onSignal = (signal: NodeJS.Signals) => {
    killGroup(api);
    // Re-raise when no one else handles it, so the default (terminate) still happens.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const stop = () => {
    process.off('exit', onExit);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    killGroup(api);
  };
  const started: StartedApi = { api, stop, killGroup: (signal) => killGroup(api, signal) };

  const fail = (message: string): never => {
    stop();
    throw new Error(message);
  };

  // Wait until it answers HTTP (page routes 404, which is fine).
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) fail(`The API (NODE_ENV=${nodeEnv}) exited with ${exited} before it answered:\n${output}`);
    if (await answers(url)) return started;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fail(`The API (NODE_ENV=${nodeEnv}) did not answer on ${url} within ${startTimeoutMs / 1000} s:\n${output}`);
}

/** Stops a started API and waits for its process to exit (SIGKILL after 5 s). */
export async function stopApi({ api, stop, killGroup }: StartedApi): Promise<void> {
  if (!api.pid || api.exitCode !== null || api.signalCode !== null) {
    stop();
    return;
  }
  const exited = new Promise((r) => api.once('exit', r));
  stop();
  const timer = setTimeout(() => killGroup('SIGKILL'), 5000);
  await exited;
  clearTimeout(timer);
}
