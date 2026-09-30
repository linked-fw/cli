import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {parseAst} from 'rollup/parseAst';
import {clientDefine, createViteConfig} from '../../src/vite-config';
import {pinDecoratedClassNames} from '../../src/plugins/pin-compiled-class-names';

// What tsc emits for a package with two decorated shapes, one of which refers
// to itself (tsc's `Bar_1` alias), plus a property decorator that — like the
// real ones — reads the class name before the class decorator runs. The module
// reads `process.env`, which makes Vite re-print it with esbuild in a client
// build and (for NODE_ENV) in the dev client.
const SHAPE_JS = `var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var Bar_1;
export const seen = [];
function linkedShape(target) { seen.push(target.name); return target; }
function literalProperty(target, key) { seen.push(target.constructor.name + '.' + key); }
let Foo = class Foo {
    static mode() { return process.env.NODE_ENV; }
    get label() { return ''; }
};
__decorate([
    literalProperty
], Foo.prototype, "label", null);
Foo = __decorate([
    linkedShape
], Foo);
export { Foo };
let Bar = Bar_1 = class Bar extends Foo {
    static make() { return new Bar_1({ id: process.env.SITE_ROOT }); }
};
Bar = Bar_1 = __decorate([
    linkedShape
], Bar);
export { Bar };
`;

const EXPECTED = {names: ['Foo', 'Bar'], seen: ['Foo.label', 'Foo', 'Bar']};

describe('pinDecoratedClassNames', () => {
  it('pins every self-named decorated class right after its declaration', () => {
    const out = pinDecoratedClassNames(SHAPE_JS, parseAst)!;
    expect(out).toContain(
      '}; Object.defineProperty(Foo, "name", {value: "Foo", configurable: true});\n__decorate([',
    );
    expect(out).toContain(
      'Object.defineProperty(Bar, "name", {value: "Bar", configurable: true});',
    );
    // Nothing moves to another line, so existing source maps stay valid.
    expect(out.split('\n').length).toBe(SHAPE_JS.split('\n').length);
  });

  it('leaves modules without a tsc-decorated class alone', () => {
    expect(
      pinDecoratedClassNames('let Foo = class Foo {};', parseAst),
    ).toBeNull();
    expect(
      pinDecoratedClassNames(
        '__decorate([x], Foo); let Foo = class {};',
        parseAst,
      ),
    ).toBeNull();
    // Not JavaScript (e.g. TypeScript reaching the hook): skipped, not thrown.
    expect(
      pinDecoratedClassNames(
        '__decorate(); let Foo = class Foo { x: number };',
        parseAst,
      ),
    ).toBeNull();
  });
});

describe('compiled shape class names through Vite', () => {
  let tmp: string;
  const cwd = process.cwd();

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-pin-names-')),
    );
    const pkg = path.join(tmp, 'node_modules', 'shapes-pkg');
    fs.mkdirSync(path.join(pkg, 'lib', 'esm'), {recursive: true});
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: 'shapes-pkg',
        type: 'module',
        exports: {'./*': './lib/esm/*.js'},
      }),
    );
    fs.writeFileSync(path.join(pkg, 'lib', 'esm', 'Shape.js'), SHAPE_JS);
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({name: 'probe', private: true}),
    );
    fs.writeFileSync(
      path.join(tmp, 'main.js'),
      `import {Foo, Bar, seen} from 'shapes-pkg/Shape';\n` +
        `console.log(JSON.stringify({names: [Foo.name, Bar.name], seen}));\n`,
    );
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  const LOADER = path.join(
    __dirname,
    '..',
    'fixtures',
    'pin-class-names',
    'run-vite.mjs',
  );

  const throughVite = (mode: 'build' | 'dev', plugin: 'on' | 'off') =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [LOADER, tmp, mode, plugin, JSON.stringify(clientDefine({port: 4999}))],
        {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8'},
      ),
    );

  it('control: without the plugin Vite renames them in a client build and the dev client', () => {
    // If this starts failing, Vite has stopped re-printing these modules
    // without keepNames and the plugin is no longer needed.
    expect(throughVite('build', 'off')).toEqual({
      names: ['Foo2', 'Bar2'],
      seen: ['Foo2.label', 'Foo2', 'Bar2'],
    });
    expect(throughVite('dev', 'off').names).toEqual(['Foo2', 'Bar2']);
  }, 60_000);

  it('with the plugin every decorator sees the original name, in a client build', () => {
    expect(throughVite('build', 'on')).toEqual(EXPECTED);
  }, 60_000);

  it('with the plugin every decorator sees the original name, in the dev client', () => {
    expect(throughVite('dev', 'on')).toEqual(EXPECTED);
  }, 60_000);

  it('createViteConfig installs the plugin in dev and build', async () => {
    process.chdir(tmp);
    for (const mode of ['development', 'production']) {
      const fn: any = createViteConfig({port: 4999});
      const config = await fn({
        mode,
        command: mode === 'development' ? 'serve' : 'build',
      });
      const names = config.plugins.flat().map((p: {name?: string}) => p?.name);
      expect(names).toContain('linked:pin-compiled-class-names');
    }
  });
});
