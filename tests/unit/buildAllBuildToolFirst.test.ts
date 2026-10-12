import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {buildAll} from '../../src/cli-methods';
import {BUILD_TOOL_PACKAGE, orderBuildToolFirst} from '../../src/lifecycle';
import type {PackageDetails} from '../../src/interfaces';

// Every other package's `build` script runs `linked build`, which is the
// `lib/` of @_linked/cli. When @_linked/cli is localized, `build-all` used to
// build it in parallel with the rest: its `rimraf ./lib` pulled that `lib/`
// out from under their builds (measured in Create Now on 2026-10-12: 6 failed
// with ENOENT …/_linked-cli/lib/esm/installed-packages.js and 15 more were
// not built, of 26). And whatever was built before it ran a stale cli. These
// tests pin that the cli is built alone, after only what it depends on itself
// (a localized @_linked/core, whose `lib/` its `tsc` needs), and that nothing
// after a failure is built.

const pkg = (packageName: string): PackageDetails => ({
  packageName,
  path: 'packages/' + packageName.replace(/\W/g, '-'),
});

function packageMap(...names: string[]) {
  return new Map(names.map((n) => [n, pkg(n)]));
}

/** A `dependenciesOf` reading from a table instead of package.json files. */
const deps =
  (table: Record<string, string[]>) =>
  (p: PackageDetails): string[] =>
    table[p.packageName] ?? [];

const CORE = '@_linked/core';

describe('orderBuildToolFirst', () => {
  it('leaves the order alone when the cli is not being built', () => {
    const packages = packageMap('@probe/a', '@probe/b');
    const order = orderBuildToolFirst(packages, undefined, deps({}));
    expect(order.tool).toBeUndefined();
    expect(order.pre.size).toBe(0);
    expect(order.start).toBe('pre');
    expect([...order.rest.keys()]).toEqual(['@probe/a', '@probe/b']);
  });

  it('takes the cli out and builds it first when it needs nothing in the plan', () => {
    const packages = packageMap('@probe/a', BUILD_TOOL_PACKAGE, '@probe/b');
    const order = orderBuildToolFirst(
      packages,
      undefined,
      deps({[BUILD_TOOL_PACKAGE]: ['chalk', '@probe/not-in-plan']}),
    );
    expect(order.tool?.packageName).toBe(BUILD_TOOL_PACKAGE);
    expect([...order.pre.keys()]).toEqual([]);
    expect(order.start).toBe('pre');
    expect([...order.rest.keys()]).toEqual(['@probe/a', '@probe/b']);
    expect(order.from).toBeUndefined();
    // The input is not modified.
    expect(packages.has(BUILD_TOOL_PACKAGE)).toBe(true);
  });

  it('builds what the cli depends on before it, and only that', () => {
    const order = orderBuildToolFirst(
      packageMap('@probe/a', BUILD_TOOL_PACKAGE, CORE),
      undefined,
      deps({
        [BUILD_TOOL_PACKAGE]: [CORE],
        '@probe/a': [CORE, BUILD_TOOL_PACKAGE],
      }),
    );
    expect([...order.pre.keys()]).toEqual([CORE]);
    expect(order.tool?.packageName).toBe(BUILD_TOOL_PACKAGE);
    expect([...order.rest.keys()]).toEqual(['@probe/a']);
  });

  it('takes the transitive closure, dependencies first, and survives a cycle back to the cli', () => {
    const order = orderBuildToolFirst(
      packageMap('@probe/a', '@probe/util', BUILD_TOOL_PACKAGE, CORE),
      undefined,
      deps({
        [BUILD_TOOL_PACKAGE]: [CORE],
        [CORE]: ['@probe/util', BUILD_TOOL_PACKAGE],
        '@probe/util': [CORE],
      }),
    );
    expect([...order.pre.keys()]).toEqual(['@probe/util', CORE]);
    expect([...order.rest.keys()]).toEqual(['@probe/a']);
  });

  it('--from inside what the cli needs resumes there, then builds the cli and the rest', () => {
    const order = orderBuildToolFirst(
      packageMap('@probe/a', BUILD_TOOL_PACKAGE, CORE),
      CORE,
      deps({[BUILD_TOOL_PACKAGE]: [CORE]}),
    );
    expect(order.start).toBe('pre');
    expect(order.from).toBe(CORE);
  });

  it('--from the cli passes over what it needs, builds it and then everything', () => {
    const order = orderBuildToolFirst(
      packageMap('@probe/a', BUILD_TOOL_PACKAGE, CORE),
      BUILD_TOOL_PACKAGE,
      deps({[BUILD_TOOL_PACKAGE]: [CORE]}),
    );
    expect(order.start).toBe('tool');
    expect(order.from).toBeUndefined();
  });

  it('--from another package resumes past the cli without rebuilding it', () => {
    const order = orderBuildToolFirst(
      packageMap('@probe/a', BUILD_TOOL_PACKAGE, CORE),
      '@probe/a',
      deps({[BUILD_TOOL_PACKAGE]: [CORE]}),
    );
    expect(order.tool?.packageName).toBe(BUILD_TOOL_PACKAGE);
    expect(order.start).toBe('rest');
    expect(order.from).toBe('@probe/a');
    expect([...order.rest.keys()]).toEqual(['@probe/a']);
  });
});

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(
  root: string,
  name: string,
  build: string,
  dependencies: Record<string, string> = {},
) {
  writeJson(path.join(root, 'package.json'), {
    name,
    version: '1.0.0',
    linkedPackage: true,
    scripts: {build},
    dependencies,
  });
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

describe('build-all with the cli in the workspace', () => {
  let tmp: string;
  let cwd: string;
  let output: string[];
  let exitCodes: (number | undefined)[];
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-buildall-cli-')),
    );
    writeJson(path.join(tmp, 'package.json'), {
      name: 'probe-root',
      private: true,
      workspaces: ['packages/*'],
    });
    cwd = process.cwd();
    process.chdir(tmp);

    output = [];
    exitCodes = [];
    const record = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
    spies = [
      jest.spyOn(console, 'log').mockImplementation(record),
      jest.spyOn(console, 'warn').mockImplementation(record),
      jest.spyOn(console, 'error').mockImplementation(record),
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true as any),
      jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        exitCodes.push(code);
      }) as any),
    ];
  });

  afterEach(() => {
    spies.forEach((s) => s.mockRestore());
    process.chdir(cwd);
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  const text = () => output.join('\n');
  const pkgDir = (dir: string) => path.join(tmp, 'packages', dir);

  async function waitFor(check: () => boolean, ms = 15000) {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) {
        throw new Error(
          'build-all did not finish. Output so far:\n' + output.join('\n'),
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function run(options: Record<string, unknown> = {}) {
    await buildAll(options);
    await waitFor(
      () => exitCodes.length > 0 || /Successfully built/.test(text()),
    );
  }

  // The cli's build takes a moment and then leaves a marker, like its `lib/`.
  // Every other build fails unless the marker is already there, the way
  // `linked build` fails while the cli's `lib/` is being rebuilt. The cli's
  // directory sorts first, so it is not the package the dependency-ordered
  // build happens to start with on its own.
  const marker = () => path.join(tmp, 'cli-built');
  const cliBuild = () => `sleep 0.3 && touch "${marker()}"`;
  const usesCli = () => `test -f "${marker()}"`;

  it('builds the cli first and alone, then the rest', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, cliBuild());
    makePackage(pkgDir('a'), '@probe/a', usesCli());
    makePackage(pkgDir('b'), '@probe/b', usesCli());

    await run();

    expect(exitCodes).toEqual([]);
    expect(text()).toMatch(
      /Building @_linked\/cli alone: the other packages build with it\./,
    );
    expect(text()).toMatch(/Successfully built: .*@_linked\/cli/);
    expect(text()).toMatch(/Successfully built: .*@probe\/a/);
    expect(text()).toMatch(/Successfully built: .*@probe\/b/);
    expect(text()).not.toMatch(/build failed|Failed to build/);
  }, 30000);

  it('builds the cli first with --sync too', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, cliBuild());
    makePackage(pkgDir('a'), '@probe/a', usesCli());
    makePackage(pkgDir('b'), '@probe/b', usesCli());

    await run({sync: true});

    expect(exitCodes).toEqual([]);
    expect(text()).not.toMatch(/build failed|Failed to build/);
  }, 30000);

  it('stops, building nothing else, when the cli fails', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, 'exit 2');
    makePackage(pkgDir('a'), '@probe/a', `touch "${path.join(tmp, 'a')}"`);

    await run();

    expect(exitCodes).toEqual([1]);
    expect(text()).toMatch(
      /@_linked\/cli failed to build, so build-all stopped before the other 1 package: they build with it/,
    );
    expect(fs.existsSync(path.join(tmp, 'a'))).toBe(false);
    expect(text()).not.toMatch(/Built @probe\/a/);
  }, 30000);

  it('--from another package does not rebuild the cli', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, 'exit 2');
    makePackage(pkgDir('a'), '@probe/a', 'echo built');

    await run({from: '@probe/a'});

    expect(exitCodes).toEqual([]);
    expect(text()).toMatch(/skipping @_linked\/cli/);
    expect(text()).toMatch(/Built @probe\/a/);
    expect(text()).not.toMatch(/alone: the other packages/);
  }, 30000);

  // A localized core the cli depends on: its build leaves a marker the cli's
  // build needs, the way the cli's `tsc` needs core's `lib/`. Its directory
  // sorts last, so nothing builds it early by accident.
  const coreMarker = () => path.join(tmp, 'core-built');
  const coreBuild = () => `sleep 0.3 && touch "${coreMarker()}"`;
  const cliNeedsCore = () => `test -f "${coreMarker()}" && ${cliBuild()}`;
  const onCore = {[CORE]: '*'};

  it('builds what the cli depends on first, then the cli alone, then the rest', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, cliNeedsCore(), onCore);
    makePackage(pkgDir('a'), '@probe/a', usesCli(), onCore);
    makePackage(pkgDir('z-core'), CORE, coreBuild());

    await run();

    expect(exitCodes).toEqual([]);
    expect(text()).toMatch(
      /Building @_linked\/core first: @_linked\/cli depends on it\./,
    );
    const at = (re: RegExp) => output.findIndex((line) => re.test(line));
    expect(at(/Built @_linked\/core/)).toBeGreaterThan(-1);
    expect(at(/Built @_linked\/core/)).toBeLessThan(
      at(/Building @_linked\/cli alone/),
    );
    expect(at(/Built @_linked\/cli/)).toBeLessThan(at(/Built @probe\/a/));
    expect(text()).not.toMatch(/build failed|Failed to build/);
    // The summary is printed once, at the end.
    expect(
      output.filter((line) => /Successfully built/.test(line)),
    ).toHaveLength(1);
    expect(text()).toMatch(/Successfully built: .*@_linked\/core/);
  }, 30000);

  it('stops before the cli when what it depends on fails', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, cliBuild(), onCore);
    makePackage(pkgDir('a'), '@probe/a', usesCli());
    makePackage(pkgDir('z-core'), CORE, 'exit 2');

    await run();

    expect(exitCodes).toEqual([1]);
    expect(text()).toMatch(
      /@_linked\/cli needs @_linked\/core, so build-all stopped before it and the other 1 package/,
    );
    expect(fs.existsSync(marker())).toBe(false);
    expect(text()).not.toMatch(/Built @probe\/a/);
  }, 30000);

  it('--from inside what the cli depends on resumes there, then builds the cli and the rest', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, cliNeedsCore(), onCore);
    makePackage(pkgDir('a'), '@probe/a', usesCli());
    makePackage(pkgDir('util'), '@probe/util', 'exit 2');
    makePackage(pkgDir('z-core'), CORE, coreBuild(), {'@probe/util': '*'});

    await run({from: CORE});

    expect(exitCodes).toEqual([]);
    expect(text()).toMatch(/skipping @probe\/util/);
    expect(text()).toMatch(/Built @_linked\/core/);
    expect(text()).toMatch(/Built @_linked\/cli/);
    expect(text()).toMatch(/Built @probe\/a/);
  }, 30000);

  it('--from the cli passes over what it depends on', async () => {
    makePackage(pkgDir('0-cli'), BUILD_TOOL_PACKAGE, cliBuild(), onCore);
    makePackage(pkgDir('a'), '@probe/a', usesCli());
    makePackage(pkgDir('z-core'), CORE, 'exit 2');

    await run({from: BUILD_TOOL_PACKAGE});

    expect(exitCodes).toEqual([]);
    expect(text()).toMatch(/skipping @_linked\/core/);
    expect(text()).toMatch(/Built @_linked\/cli/);
    expect(text()).toMatch(/Built @probe\/a/);
  }, 30000);
});
