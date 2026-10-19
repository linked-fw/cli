// Keeps `linked start`'s Vite dev server for the life of the process.
//
// Its own module, importing only `node:path` and types, so a test can load it
// in a plain Node process next to a real Vite server
// (tests/fixtures/dev-server-restart/run.mjs).
import path from 'node:path';
import type {Plugin} from 'vite';

/**
 * Whether Vite would restart its dev server for a change to `file`: one of its
 * env files (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`, in
 * `envDir`) or the config file it loaded.
 */
export function isDevServerRestartTrigger(
  file: string,
  config: {envDir?: string | false; configFile?: string},
): boolean {
  const abs = path.resolve(file);
  if (config.configFile && abs === path.resolve(config.configFile)) return true;
  if (!config.envDir) return false;
  return (
    path.dirname(abs) === path.resolve(config.envDir) &&
    /^\.env(\.|$)/.test(path.basename(abs))
  );
}

/**
 * Keep `linked start`'s Vite dev server for the life of the process.
 *
 * Vite restarts its dev server when an env file or its config file changes: it
 * closes the SSR module runner and builds a new one with an empty module cache.
 * A Vite app reloads its modules after that. This backend cannot: LinkedServer,
 * the providers and the storage config were evaluated by the first runner, and
 * every `import()` they make (`import('@_linked/core')` in the shape sync, a
 * provider's lazy import) is bound to it, so each one fails with "Vite module
 * runner has been closed." until the process restarts. Loading them again
 * through the new runner is no way out either: it evaluates a second copy of
 * each module, beside the instances already registered.
 *
 * So the watcher never reports those files and Vite never restarts. Nothing in
 * the process re-reads them anyway: `.env` is loaded into `process.env` once at
 * boot, and a host's injected variables win over it. A change to either file
 * takes effect at the next `linked start`. If the server restarts regardless (a
 * file the config imports changed, or a plugin called `server.restart()`), the
 * log says the process must be restarted.
 */
export function keepDevServerAlive(
  warn: (message: string) => void = (message) => console.warn(message),
): Plugin {
  let resolved: {envDir?: string | false; configFile?: string} = {};
  let servers = 0;
  return {
    name: 'linked:keep-dev-server-alive',
    config: () => ({
      server: {
        watch: {
          ignored: [(file: string) => isDevServerRestartTrigger(file, resolved)],
        },
      },
    }),
    configResolved(config) {
      resolved = {envDir: config.envDir, configFile: config.configFile};
    },
    configureServer() {
      servers += 1;
      if (servers > 1) {
        warn(
          '[linked] Vite restarted its dev server. The backend was loaded by the ' +
            'module runner it closed, so it can no longer load code ("Vite module ' +
            'runner has been closed."). Restart `linked start`.',
        );
      }
    },
  };
}
