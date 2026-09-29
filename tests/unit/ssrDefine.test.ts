import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {clientDefine, createViteConfig} from '../../src/vite-config';

// A shape's IRI is built from its class name, so anything that renames a shape
// class changes the shape's identity.
//
// Vite's `vite:define` plugin runs `esbuild.transform` — without `keepNames` —
// over every SSR module whose text contains a `define` key. esbuild renames the
// inner binding of the class expression tsc emits for a decorated class, so
// `let Foo = class Foo` loads as a class named `Foo2`. That is how
// `@_linked/server`'s `LinkedServer` and `LincdAPI` (compiled lib JS that reads
// `process.env.NODE_ENV`) registered as `LinkedServer2` / `LincdAPI2` in dev.
// `createViteConfig` therefore gives its `process.env.*` defines to the client
// environment only.

// What tsc emits for `@linkedShape export class Foo`, plus references to two of
// the keys `createViteConfig` defines.
const SHAPE_JS = `var __decorate = function (decorators, target) { return target; };
function linkedShape(target) { return target; }
let Foo = class Foo {
  static mode() { return process.env.NODE_ENV; }
};
Foo = __decorate([linkedShape], Foo);
export { Foo };
export const siteRoot = process.env.SITE_ROOT;
`;

const LOADER = path.join(__dirname, '..', 'fixtures', 'ssr-define', 'load-shape.mjs');

function loadThroughSsr(root: string, config: {define?: unknown; environments?: unknown}) {
  const out = execFileSync(process.execPath, [LOADER, root, JSON.stringify(config)], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    env: {...process.env, SITE_ROOT: ''},
  });
  return JSON.parse(out) as {name: string; siteRoot: string | null};
}

describe('process.env defines are client-only', () => {
  let tmp: string;
  const cwd = process.cwd();

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-define-')));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({name: 'probe', private: true}));
    fs.writeFileSync(path.join(tmp, 'shape.js'), SHAPE_JS);
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  async function resolvedConfig(mode: string) {
    process.chdir(tmp);
    const fn: any = createViteConfig({port: 4999});
    return fn({mode, command: mode === 'development' ? 'serve' : 'build'});
  }

  it('control: a top-level define renames a decorated class in SSR', () => {
    // If this starts failing, Vite has stopped renaming (e.g. it passes
    // keepNames to its define transform) and the client-only split is no
    // longer load-bearing for class names — only for runtime env reads.
    const result = loadThroughSsr(tmp, {define: clientDefine({port: 4999})});
    expect(result.name).toBe('Foo2');
  }, 60_000);

  it('createViteConfig leaves SSR class names and runtime env alone', async () => {
    const config = await resolvedConfig('development');
    const result = loadThroughSsr(tmp, {define: config.define, environments: config.environments});
    expect(result.name).toBe('Foo');
    // Read at runtime from the (emptied) env, not inlined from the config.
    expect(result.siteRoot).toBe('');
  }, 60_000);

  it('the client environment still gets every define, including the app’s own', async () => {
    process.chdir(tmp);
    const fn: any = createViteConfig({
      port: 4999,
      define: {'process.env.MY_PUBLIC_KEY': JSON.stringify('k')},
    });
    const config = await fn({mode: 'production', command: 'build'});
    expect(config.define).toBeUndefined();
    expect(Object.keys(config.environments.client.define).sort()).toEqual([
      'process.env.APP_NAME',
      'process.env.MY_PUBLIC_KEY',
      'process.env.NODE_ENV',
      'process.env.SITE_ROOT',
    ]);
    expect(config.environments.ssr).toBeUndefined();
  });
});
