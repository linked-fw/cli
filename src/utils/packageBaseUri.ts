/**
 * The root a new package's IRIs are minted under: `linkedPackage(name, {baseUri})`
 * gives shapes `{baseUri}shape/{slug}/{Name}`, and an ontology package's terms are
 * `{baseUri}ont/{ontologySlug}/{Term}`. Without one, core's default
 * (`https://linked.cm/`) applies.
 *
 * Where it comes from, first match wins:
 *
 *   1. `--base-uri <uri>`: explicit, and what a script or a host passes.
 *   2. `LINKED_BASE_URI` in the shell environment.
 *   3. `LINKED_BASE_URI` in the app's `.env.local`, then its `.env`.
 *
 * 2 and 3 are the variable the app template documents as "the root of this
 * app's package and shape IRIs", read with the same precedence `linked start`
 * gives the app's `.env` (the shell wins over the file). The file is parsed, not
 * loaded, so creating a package never changes this process's environment.
 * `linked.config.js` is not a source: it is a module that would have to be
 * imported (running the app's code) just to scaffold a package, and it has no
 * IRI setting today.
 */
import fs from 'fs';
import path from 'path';
import {parseEnv} from 'util';

export const BASE_URI_ENV = 'LINKED_BASE_URI';

export type BaseUriSource = '--base-uri' | 'environment' | '.env.local' | '.env';

export interface ResolvedBaseUri {
  baseUri: string;
  source: BaseUriSource;
}

/**
 * A root as IRIs are appended to it: absolute http(s), no query or fragment,
 * ending in `/`. Mirrors the app template's `resolveBaseUri`. Empty → undefined.
 */
export function normalizeBaseUri(value: string | undefined, from: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    url.search ||
    url.hash ||
    /\s/.test(trimmed) ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new Error(
      `${from} must be an absolute http(s) URI without a query or fragment, got ${JSON.stringify(value)}`,
    );
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** `LINKED_BASE_URI` from an env file, or undefined when the file or the key is absent. */
function fromEnvFile(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return parseEnv(fs.readFileSync(file, 'utf8'))[BASE_URI_ENV];
}

/**
 * The base URI for a package created in `appRoot` (null outside an app, where
 * only the flag counts). Undefined when no source sets one.
 */
export function resolvePackageBaseUri({
  flag,
  appRoot,
  env = process.env,
}: {
  flag?: string;
  appRoot: string | null;
  env?: NodeJS.ProcessEnv;
}): ResolvedBaseUri | undefined {
  const fromFlag = normalizeBaseUri(flag, '--base-uri');
  if (fromFlag) return {baseUri: fromFlag, source: '--base-uri'};
  if (!appRoot) return undefined;

  const fromShell = normalizeBaseUri(env[BASE_URI_ENV], BASE_URI_ENV);
  if (fromShell) return {baseUri: fromShell, source: 'environment'};

  for (const name of ['.env.local', '.env'] as const) {
    const file = path.join(appRoot, name);
    const value = normalizeBaseUri(fromEnvFile(file), `${BASE_URI_ENV} in ${file}`);
    if (value) return {baseUri: value, source: name};
  }
  return undefined;
}

/**
 * Give a scaffolded `src/package.ts` its root: `linkedPackage('x')` →
 * `linkedPackage('x', {baseUri: '…'})`. Throws when the call is not found, so a
 * template change cannot silently drop the root.
 */
export function withBaseUri(packageTs: string, baseUri: string): string {
  const call = /linkedPackage\(\s*(['"][^'"]+['"])\s*\)/;
  if (!call.test(packageTs)) {
    throw new Error('src/package.ts has no linkedPackage(<name>) call to give a baseUri to.');
  }
  return packageTs.replace(call, `linkedPackage($1, {baseUri: ${JSON.stringify(baseUri)}})`);
}
