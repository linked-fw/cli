// Loads a tsc-shaped decorated class through Vite's SSR module runner and
// prints the class's runtime name.
//
// Run as a child process by tests/unit/ssrDefine.test.ts: Vite is ESM-only in
// practice and Jest runs the unit tests as CommonJS, so the real
// `ssrLoadModule` has to happen out here.
//
// argv[2]: the directory to serve. argv[3]: JSON with the `define` and
// `environments` fields of the config under test — the only fields the
// behaviour depends on.
import path from 'path';
import {createServer} from 'vite';

const [root, configJson] = process.argv.slice(2);
const {define, environments} = JSON.parse(configJson);

const server = await createServer({
  configFile: false,
  root,
  logLevel: 'silent',
  define,
  environments,
  optimizeDeps: {noDiscovery: true, entries: []},
  server: {middlewareMode: true, hmr: false, ws: false},
});
try {
  const mod = await server.ssrLoadModule(path.join(root, 'shape.js'));
  process.stdout.write(JSON.stringify({name: mod.Foo.name, siteRoot: mod.siteRoot ?? null}));
} finally {
  await server.close();
}
