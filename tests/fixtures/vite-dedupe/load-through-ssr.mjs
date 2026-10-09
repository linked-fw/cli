// Loads a localized checkout's module through Vite's SSR module runner and
// prints which copy of `@_linked/core` it got.
//
// Run as a child process by tests/unit/viteDedupe.test.ts, for the same reason
// as ../ssr-define/load-shape.mjs: Vite is ESM-only in practice and Jest runs
// the unit tests as CommonJS.
//
// argv[2]: the app root. argv[3]: the file to load. argv[4]: JSON with the
// `resolve` field of the config under test — the only field the behaviour
// depends on.
import {createServer} from 'vite';

const [root, file, resolveJson] = process.argv.slice(2);
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'silent',
  resolve: JSON.parse(resolveJson),
  optimizeDeps: {noDiscovery: true, entries: []},
  server: {middlewareMode: true, hmr: false, ws: false},
});
try {
  const mod = await server.ssrLoadModule(file);
  process.stdout.write(JSON.stringify({core: mod.core}));
} finally {
  await server.close();
}
