// Which CSS-module naming the Node CSS loader uses, decided before it starts.
//
// The loader (`loaders/css-loader.mts`) runs on Node's module-hooks thread,
// which is created by the first `register()` call in `launch.ts` and gets a
// COPY of `process.env` as it is at that moment. The CLI only loads the app's
// `.env` / `.env-cmdrc.json` afterwards (`lifecycle.ensureEnvironmentLoaded`,
// `commands/start.ts`), so a `NODE_ENV=development` that comes from a file never
// reaches the loader. It used to read `process.env.NODE_ENV` itself, saw nothing,
// and named every package stylesheet the production way while the dev client
// used the dev names: a hydration mismatch on every externalised component.
//
// So `launch.ts` resolves the mode here, on the main thread, from the same
// sources and in the same precedence the CLI applies later, and hands it to the
// loader through `register(url, {data})`. This module must stay light: it runs
// before the CLI itself is imported, so it uses node builtins only.
import fs from 'fs';
import path from 'path';
import util from 'util';

export type CssNamingMode = 'development' | 'production';

export interface LoaderModeResolution {
  /** The NODE_ENV the CLI will run with, as far as it can be known before it loads. */
  nodeEnv: string | undefined;
  /** Where `nodeEnv` came from — for diagnostics and tests. */
  source: 'shell' | '.env' | '.env-cmdrc.json' | 'vite-default' | 'unset';
  mode: CssNamingMode;
}

/**
 * Only `development` gets the dev names. Anything else — `production`,
 * `staging`, unset — serves compiled output, whose stylesheet was written with
 * the production names (see css-module-names.ts).
 */
export const cssNamingModeFor = (nodeEnv: string | undefined): CssNamingMode =>
  nodeEnv === 'development' ? 'development' : 'production';

/** `--env a,b` → `['a', 'b']`. Shared with `lifecycle.ts`, which applies the same profiles. */
export const readEnvNamesFromArgv = (
  argv: string[] = process.argv,
): string[] => {
  const args = argv.slice(2);
  const envIndex = args.indexOf('--env');
  if (envIndex === -1) return [];
  return (args[envIndex + 1] || '').split(',').filter(Boolean);
};

/** The CLI command being run: the first argument that is not an option. */
const commandFromArgv = (argv: string[]): string | undefined =>
  argv.slice(2).find((arg) => !arg.startsWith('-'));

const parseDotEnv = (source: string): Record<string, string> => {
  // `util.parseEnv` is the parser `process.loadEnvFile` uses (Node 20.12+/21.7+).
  const parseEnv = (
    util as {parseEnv?: (content: string) => Record<string, string>}
  ).parseEnv;
  if (typeof parseEnv === 'function') return parseEnv(source);
  const vars: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2].replace(/^(['"`])(.*)\1$/, '$2');
  }
  return vars;
};

/**
 * The NODE_ENV the CLI is going to run with, read the way
 * `lifecycle.ensureEnvironmentLoaded` will apply it:
 *
 *   1. the shell — it always wins over a file;
 *   2. `.env`, when present — and then `.env-cmdrc.json` is ignored entirely;
 *   3. `.env-cmdrc.json` — `_main`, then the `--env a,b` profiles, or
 *      `development` when none are named;
 *   4. otherwise, for `linked start`, `development`: the command serves through
 *      a Vite dev server, and Vite sets `NODE_ENV=development` itself when it is
 *      unset and writes the client with the dev names;
 *   5. otherwise unset, which names production.
 *
 * Pure apart from reading the two files, so it can be tested without a launch.
 */
export const resolveLoaderMode = ({
  env = process.env,
  cwd = process.cwd(),
  argv = process.argv,
}: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  argv?: string[];
} = {}): LoaderModeResolution => {
  const resolved = (
    nodeEnv: string | undefined,
    source: LoaderModeResolution['source'],
  ): LoaderModeResolution => ({
    nodeEnv,
    source,
    mode: cssNamingModeFor(nodeEnv),
  });

  if (env.NODE_ENV) return resolved(env.NODE_ENV, 'shell');

  const dotEnvPath = path.join(cwd, '.env');
  const envCmdrcPath = path.join(cwd, '.env-cmdrc.json');
  try {
    if (fs.existsSync(dotEnvPath)) {
      const fromFile = parseDotEnv(
        fs.readFileSync(dotEnvPath, 'utf8'),
      ).NODE_ENV;
      if (fromFile) return resolved(fromFile, '.env');
    } else if (fs.existsSync(envCmdrcPath)) {
      const profiles = JSON.parse(fs.readFileSync(envCmdrcPath, 'utf8')) ?? {};
      const requested = readEnvNamesFromArgv(argv);
      let fromFile: unknown = profiles._main?.NODE_ENV;
      for (const name of requested.length ? requested : ['development']) {
        if (profiles[name]?.NODE_ENV !== undefined)
          fromFile = profiles[name].NODE_ENV;
      }
      if (fromFile) return resolved(String(fromFile), '.env-cmdrc.json');
    }
  } catch {
    // An unreadable file is reported by the CLI when it loads it; the loader
    // falls through to the default rather than blocking the launch.
  }

  if (commandFromArgv(argv) === 'start')
    return resolved('development', 'vite-default');
  return resolved(undefined, 'unset');
};
