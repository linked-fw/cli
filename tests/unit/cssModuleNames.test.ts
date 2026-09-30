import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {pathToFileURL} from 'url';
import {
  cssModuleClassNames,
  cssModuleExports,
  generateScopedNameProduction,
} from '../../src/css-module-names';
import {createViteConfig} from '../../src/vite-config';

// A component library's stylesheet as it ships in lib/: the class names a
// component reads (`Root`, `small`, `ring`), written the ways real ones are.
const BUTTON_CSS = `/* .commentedOut { color: red } */
.Root {
  display: inline-flex;
  transition: opacity .2s;
}
.Root.small{padding:0.5rem}
.Root:hover > .ring,.is-active{opacity:1}
@media (min-width: 40em) { .Root { gap: 1.5em; } }
`;

/** Installs `ui-pkg` (dual ESM/CJS lib, as @_linked packages ship) under `root`. */
const installUiPackage = (root: string) => {
  const pkg = path.join(root, 'node_modules', 'ui-pkg');
  for (const flavour of ['esm', 'cjs']) {
    const dir = path.join(pkg, 'lib', flavour);
    fs.mkdirSync(dir, {recursive: true});
    // tsconfig-to-dual-package copies the manifest, name included, into each lib folder.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ui-pkg'}));
    fs.writeFileSync(path.join(dir, 'Button.module.css'), BUTTON_CSS);
  }
  fs.writeFileSync(
    path.join(pkg, 'lib', 'esm', 'Button.js'),
    `import styles from './Button.module.css';\nexport default styles;\n`,
  );
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({name: 'ui-pkg', type: 'module', exports: {'./*': './lib/esm/*'}}),
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'probe', private: true}));
  fs.writeFileSync(
    path.join(root, 'main.js'),
    `import styles from 'ui-pkg/Button.js';\nconsole.log(JSON.stringify(styles));\n`,
  );
  return path.join(pkg, 'lib', 'esm', 'Button.module.css');
};

describe('production CSS-module names', () => {
  const roots: string[] = [];
  const tempRoot = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-css-names-')));
    roots.push(dir);
    return dir;
  };
  afterAll(() => roots.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})));

  it('finds every class a stylesheet defines, and none from comments or numbers', () => {
    expect(cssModuleClassNames(BUTTON_CSS).sort()).toEqual(['Root', 'is-active', 'ring', 'small']);
  });

  it('do not depend on where the package is installed, its build flavour, or path vs URL', () => {
    const a = installUiPackage(tempRoot());
    const b = installUiPackage(tempRoot());
    const name = generateScopedNameProduction('Root', a);
    expect(name).toMatch(/^_Root_[0-9a-f]{6}$/);
    expect(generateScopedNameProduction('Root', b)).toBe(name);
    expect(generateScopedNameProduction('Root', a.replace('/lib/esm/', '/lib/cjs/'))).toBe(name);
    expect(generateScopedNameProduction('Root', pathToFileURL(a).href)).toBe(name);
    expect(generateScopedNameProduction('Root', `${a}?inline`)).toBe(name);
    expect(generateScopedNameProduction('small', a)).not.toBe(name);
  });

  it('createViteConfig uses them for production builds', async () => {
    const cwd = process.cwd();
    process.chdir(tempRoot());
    try {
      const config: any = await (createViteConfig({port: 4999}) as any)({mode: 'production', command: 'build'});
      expect(config.css.modules.generateScopedName).toBe(generateScopedNameProduction);
    } finally {
      process.chdir(cwd);
    }
  });

  it('the server loader maps a package stylesheet to the names the client build wrote', () => {
    // The client: a real Vite build of an app importing the package.
    const clientRoot = tempRoot();
    installUiPackage(clientRoot);
    const client = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(__dirname, '..', 'fixtures', 'css-module-names', 'build-client.mjs'), clientRoot],
        {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8'},
      ),
    );

    // The server: what the Node loader returns for the same package, installed
    // somewhere else, reached through the file URL Node hands the loader.
    const serverCss = installUiPackage(tempRoot());
    const server = cssModuleExports(
      fs.readFileSync(serverCss, 'utf8'),
      pathToFileURL(serverCss).href,
    );

    expect(server).toEqual(client.classes);
    for (const scoped of Object.values(client.classes) as string[]) {
      expect(client.css).toContain(`.${scoped}`);
    }
  }, 60_000);
});
