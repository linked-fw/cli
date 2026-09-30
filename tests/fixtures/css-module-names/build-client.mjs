// Builds a fixture app's client with Vite, using the production CSS-module
// naming, and prints what the client ended up with: the class map the bundle's
// JS holds, and the stylesheet Vite wrote.
//
// Run as a child process by tests/unit/cssModuleNames.test.ts: Vite's Node API
// is ESM-only in practice and Jest runs the unit tests as CommonJS.
//
// argv[2]: the fixture root (holds main.js and node_modules/ui-pkg).
import {execFileSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import esbuild from 'esbuild';
import {build} from 'vite';

const [root] = process.argv.slice(2);

// css-module-names.ts imports only node builtins, so a plain TS->JS transform loads it.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', '..', 'src', 'css-module-names.ts');
const {code} = await esbuild.transform(fs.readFileSync(src, 'utf8'), {loader: 'ts', format: 'esm'});
const {generateScopedNameProduction} = await import(
  'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
);

const outDir = path.join(root, 'dist');
await build({
  root,
  configFile: false,
  logLevel: 'silent',
  css: {modules: {generateScopedName: generateScopedNameProduction}},
  build: {
    outDir,
    minify: false,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {input: path.join(root, 'main.js'), output: {format: 'es', entryFileNames: 'main.js'}},
  },
});

const files = fs.readdirSync(path.join(outDir, 'assets'));
const css = files
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8'))
  .join('\n');
const classes = JSON.parse(execFileSync(process.execPath, [path.join(outDir, 'main.js')], {encoding: 'utf8'}));
process.stdout.write(JSON.stringify({classes, css}));
