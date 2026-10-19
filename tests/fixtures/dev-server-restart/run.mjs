// Boots a Vite dev server the way `linked start` does (middleware mode, SSR
// module runner), loads a module that imports another lazily — as
// LinkedServer's shape sync does with `import('@_linked/core')` — then changes
// `.env` or restarts the server, and reports what the module loaded before can
// still do.
//
// Run as a child process by tests/unit/keepDevServerAlive.test.ts: Jest runs
// the unit tests as CommonJS, where Vite cannot start. The plugin is imported
// from source (Node strips its types).
//
// argv[2]: the directory to serve, holding `.env`, `lazy.js` and `later.js`.
// argv[3]: `plugin` (with keepDevServerAlive), `stock` (without it) or
// `restart` (with it, then `server.restart()`).
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'vite';
import {keepDevServerAlive} from '../../../src/plugins/keep-dev-server-alive.ts';

const [root, mode] = process.argv.slice(2);
const warnings = [];
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'silent',
  appType: 'custom',
  optimizeDeps: {noDiscovery: true, entries: []},
  server: {middlewareMode: true, ws: false},
  plugins: mode === 'stock' ? [] : [keepDevServerAlive((m) => warnings.push(m))],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lazyImport = (mod) =>
  mod.later().then(
    (m) => ({ok: true, value: m.value}),
    (err) => ({ok: false, error: err.message}),
  );

try {
  // Let the watcher finish its initial scan, so the write below is a change.
  await sleep(500);
  const before = await server.ssrLoadModule('/lazy.js');
  if (mode === 'restart') {
    await server.restart();
  } else {
    fs.writeFileSync(path.join(root, '.env'), 'A=2\n');
    fs.writeFileSync(path.join(root, '.env.local'), 'B=1\n');
  }
  // Stock Vite restarts within ~100 ms of an env change; wait well past it,
  // stopping early once the runner is closed.
  let after = await lazyImport(before);
  for (let i = 0; i < 20 && after.ok; i++) {
    await sleep(100);
    after = await lazyImport(before);
  }
  // The runner closes before the restart finishes, so a load right after the
  // failure can still meet the closed one: retry until the new server answers.
  let reloaded;
  for (let i = 0; !reloaded; i++) {
    try {
      reloaded = await server.ssrLoadModule('/lazy.js');
    } catch (err) {
      if (i >= 50) throw err;
      await sleep(100);
    }
  }
  // Mid-restart the failure can read "transport was disconnected"; once the
  // restart is done, ask again for the settled answer.
  if (!after.ok) after = await lazyImport(before);
  process.stdout.write(
    JSON.stringify({lazyImport: after, sameInstance: reloaded.instance === before.instance, warnings}),
  );
} finally {
  await server.close();
}
