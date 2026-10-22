// Measures where ontology data (Turtle read beside a module through
// `import.meta.url`) ends up in each build mode of an app, and prints JSON.
//
// Run as a child process by tests/unit/ontologyDataReachable.test.ts: Vite's
// Node API is ESM-only in practice and Jest runs the unit tests as CommonJS.
// The CLI is imported from its built `lib/esm` (the build runs before the
// unit tests, locally and in CI), since `vite-config.ts` cannot be loaded
// from source by Node.
//
// argv[2]: `release` (the backend build of `linked build-app`), `dev` (the
// dev server's SSR runner, as `linked start` loads the app) or `client` (the
// client bundle). argv[3]: the app root, a copy of `app/` with its
// `node_modules`.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build, createLogger, createServer, mergeConfig} from 'vite';

const [mode, appRoot] = process.argv.slice(2);
// Vite logs to stdout too; the result is the last line.
const report = (result) => process.stdout.write('\n' + JSON.stringify(result) + '\n');
const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'lib', 'esm');
const cliModule = (rel) => import(pathToFileURL(path.join(cli, rel)).href);

process.chdir(appRoot);

const describe = async (mod) => ({
  app: {text: (await mod.appData())[0], url: mod.appModuleUrl()},
  pkg: {text: (await mod.packageData())[0], url: mod.packageModuleUrl()},
});

if (mode === 'release') {
  const {buildBackendWithVite, copyBackendOntologyData} = await cliModule('app-release/build-backend.js');
  const {getFiles} = await cliModule('utils.js');
  await buildBackendWithVite({appRoot});
  const copied = await copyBackendOntologyData(appRoot, (dir) => getFiles(dir, '.ttl'));
  const mod = await import(pathToFileURL(path.join(appRoot, 'lib', 'backend.js')).href);
  const probeJs = fs.readFileSync(path.join(appRoot, 'lib', 'ontologies', 'probe.js'), 'utf8');
  report({
    ...(await describe(mod)),
    copied,
    probeJsImportMetaUrl: (probeJs.match(/import\.meta\.url/g) ?? []).length,
    libFiles: fs.readdirSync(path.join(appRoot, 'lib'), {recursive: true}).filter((f) => !f.endsWith('.map')).sort(),
  });
} else if (mode === 'dev') {
  const {createViteConfig} = await cliModule('vite-config.js');
  const configured = await createViteConfig({port: 4999})({mode: 'development', command: 'serve'});
  const server = await createServer(
    mergeConfig(configured, {
      configFile: false,
      root: appRoot,
      logLevel: 'silent',
      optimizeDeps: {noDiscovery: true, entries: []},
      server: {middlewareMode: true, hmr: false, ws: false},
    }),
  );
  try {
    const out = await describe(await server.ssrLoadModule('/src/backend.ts'));
    if (fs.existsSync(path.join(appRoot, 'src', 'ws.ts'))) {
      const ws = await server.ssrLoadModule('/src/ws.ts');
      out.ws = {text: (await ws.loadData())[0], url: ws.moduleUrl()};
    }
    report(out);
  } finally {
    await server.close();
  }
} else if (mode === 'client') {
  const {createViteConfig} = await cliModule('vite-config.js');
  const configured = await createViteConfig({port: 4999, entry: 'src/client.ts'})({mode: 'production', command: 'build'});
  const warnings = [];
  const logger = createLogger('warn', {allowClearScreen: false});
  const warn = logger.warn;
  logger.warn = (msg, opts) => {
    warnings.push(msg);
    warn(msg, opts);
  };
  logger.warnOnce = logger.warn;
  await build(mergeConfig(configured, {configFile: false, root: appRoot, customLogger: logger}));
  const outDir = path.join(appRoot, 'public', 'bundles');
  const files = fs.readdirSync(outDir, {recursive: true}).filter((f) => fs.statSync(path.join(outDir, f)).isFile());
  const ttlContent = files.filter((f) => fs.readFileSync(path.join(outDir, f), 'utf8').includes('owl:Ontology'));
  report({files: files.sort(), ttlContent, warnings});
} else {
  throw new Error('unknown mode ' + mode);
}
