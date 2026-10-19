/// <reference types="node" />
// Shared by globalSetup, globalTeardown and the tests: where the test API and Fuseki live.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const API_PORT = 4100;
export const API_URL = `http://localhost:${API_PORT}`;
// productionWrites.test.ts starts a second API, with NODE_ENV=production, on this port.
export const PRODUCTION_API_PORT = 4101;
export const PRODUCTION_API_URL = `http://localhost:${PRODUCTION_API_PORT}`;
// globalSetup deletes this dataset, so it must end in `-test` (checked there).
export const FUSEKI_DATASET = 'app-test';

export const repoRoot = resolve(__dirname, '../../../..');
export const apiDir = resolve(repoRoot, 'services/api');

/** Minimal KEY=VALUE parser for services/api/.env: no expansion, no multi-line values. */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    vars[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

/** services/api/.env as key/value pairs; empty when the file does not exist. */
export function readApiEnvFile(): Record<string, string> {
  const envFile = resolve(apiDir, '.env');
  return existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
}

/** The parts of a `spawnSync('docker', ['compose', 'port', 'fuseki', '3030'])` result that explain a failure. */
export type ComposePortResult = {
  error?: (Error & { code?: string }) | undefined;
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
};

/**
 * Why `docker compose port fuseki 3030` gave no port: Docker is not installed, Docker Compose is unavailable, or
 * this repo's Compose Fuseki is not running.
 */
export function describeComposePortFailure(result: ComposePortResult): string {
  const output = (result.stderr || result.error?.message || result.stdout || '').trim();
  if (result.error?.code === 'ENOENT') {
    return 'Docker is not installed or not on PATH (`docker` could not be started). Install Docker, then run `npm run fuseki:up`.';
  }
  const composeMissing =
    /is not a docker command/i.test(output) ||
    (result.status !== 0 && /compose/i.test(output) && !/not running|no container/i.test(output));
  if (composeMissing) {
    return `Docker Compose is not available (\`docker compose port fuseki 3030\`: ${output}). Install the Docker Compose plugin, then run \`npm run fuseki:up\`.`;
  }
  return `this repo's Compose Fuseki is not running (\`docker compose port fuseki 3030\`: ${output}). Run \`npm run fuseki:up\`.`;
}

export type FusekiEnv ={ baseUrl: string; user: string; password: string };

/**
 * The Fuseki the tests talk to. services/api/.env is the source, and the shell wins: FUSEKI_BASE_URL, or
 * FUSEKI_PORT (the Compose host port) as a shorthand for localhost.
 */
export function resolveFusekiEnv(env: NodeJS.ProcessEnv = process.env): FusekiEnv {
  const file = readApiEnvFile();
  const baseUrl =
    env.FUSEKI_BASE_URL ||
    (env.FUSEKI_PORT ? `http://localhost:${env.FUSEKI_PORT}` : '') ||
    file.FUSEKI_BASE_URL ||
    'http://localhost:3030';
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    user: env.FUSEKI_USER || file.FUSEKI_USER || 'admin',
    password: env.FUSEKI_PASSWORD || file.FUSEKI_PASSWORD || 'admin',
  };
}
