// The app's prefix map (`linked.app.json`) in its browser bundle: a virtual module that loads the
// map into core, imported first by the client entry. Apps write no code for it.
import fs from 'node:fs';
import path from 'node:path';
import type {Plugin} from 'vite';
import {
  APP_CONFIG_FILE,
  appPrefixesModuleCode,
  readAppConfig,
} from '../utils/appConfig.js';

/** The virtual module the client entry imports. */
export const APP_PREFIXES_MODULE = 'virtual:linked-app-prefixes';
const RESOLVED = '\0' + APP_PREFIXES_MODULE;

/**
 * The Vite plugin: `virtual:linked-app-prefixes` loads the app's map (`Prefix.load`), or is empty
 * when the app has no `linked.app.json`; the client entry (`entry`, relative to `appRoot`) imports
 * it before anything else, on its first line so no line moves. Server-side modules are untouched:
 * the server loads the map at start. An invalid `linked.app.json` fails the build.
 */
export function appPrefixes(options: {appRoot: string; entry: string}): Plugin {
  const entry = path.resolve(options.appRoot, options.entry);
  const file = path.join(options.appRoot, APP_CONFIG_FILE);
  return {
    name: 'linked:app-prefixes',
    resolveId(id) {
      return id === APP_PREFIXES_MODULE ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      if (!fs.existsSync(file)) return 'export {};\n';
      // A change to the file reloads the module (and the page) in dev.
      this.addWatchFile(file);
      return appPrefixesModuleCode(readAppConfig(options.appRoot)!.prefixes);
    },
    transform(code, id, transformOptions) {
      if (transformOptions?.ssr) return null;
      if (id.replace(/[?#].*$/, '') !== entry) return null;
      return {code: `import '${APP_PREFIXES_MODULE}';${code}`, map: null};
    },
  };
}
