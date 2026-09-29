// Runs a compiled shape module through Vite's client pipeline and prints the
// runtime class names its decorators saw.
//
// Run as a child process by tests/unit/pinCompiledClassNames.test.ts: Vite's
// Node API is ESM-only in practice and Jest runs the unit tests as CommonJS.
//
// argv[2]: the fixture root (holds main.js and node_modules/shapes-pkg).
// argv[3]: 'build' (client production build) or 'dev' (dev-server client
//          transform). argv[4]: 'on' to install the plugin, 'off' for the
//          control. argv[5]: JSON of the client `define`.
import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import esbuild from 'esbuild';
import {build, createServer} from 'vite';

const [root, mode, plugin, defineJson] = process.argv.slice(2);
const define = JSON.parse(defineJson);

// The plugin has no runtime imports, so a plain TS->JS transform can load it.
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = path.join(here, '..', '..', '..', 'src', 'plugins', 'pin-compiled-class-names.ts');
const {code: pluginJs} = await esbuild.transform(fs.readFileSync(pluginSrc, 'utf8'), {loader: 'ts', format: 'esm'});
const {pinCompiledClassNames} = await import('data:text/javascript;base64,' + Buffer.from(pluginJs).toString('base64'));
const plugins = plugin === 'on' ? [pinCompiledClassNames()] : [];

const runNode = (file) => execFileSync(process.execPath, [file], {encoding: 'utf8'});

if (mode === 'build') {
  const outDir = path.join(root, 'dist');
  await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins,
    esbuild: {keepNames: true},
    environments: {client: {define}},
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {input: path.join(root, 'main.js'), output: {entryFileNames: 'main.mjs'}},
    },
  });
  process.stdout.write(runNode(path.join(outDir, 'main.mjs')));
} else {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins,
    environments: {client: {define}},
    optimizeDeps: {noDiscovery: true, entries: []},
    server: {middlewareMode: true, hmr: false, ws: false},
  });
  try {
    const result = await server.environments.client.transformRequest('/node_modules/shapes-pkg/lib/esm/Shape.js');
    const file = path.join(root, 'served.mjs');
    fs.writeFileSync(file, result.code + '\nconsole.log(JSON.stringify({names: [Foo.name, Bar.name], seen}));\n');
    process.stdout.write(runNode(file));
  } finally {
    await server.close();
  }
}
