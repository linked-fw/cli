import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import {buildAll} from '../../src/cli-methods';

// `build-all` runs each package's own `build` script. A script that exits
// non-zero used to be counted as built: the rejection was turned into an
// `{error}` object, which is not `undefined`, so the success branch ran and the
// run printed "Successfully built" and exited 0. These tests run real build
// scripts in a throwaway workspace and pin that a failure is reported and
// fails the run, and that a failure never stops the rest of the workspace
// from building: dependents of a failed package are reported as not built,
// everything else is built, and the run exits 1 once, after the summary.

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

describe('build-all with a failing package', () => {
  let tmp: string;
  let cwd: string;
  let output: string[];
  let exitCodes: (number | undefined)[];
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-buildall-fail-')),
    );
    // No `linkedApp` root, so every package with a build script is built.
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
      jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true as any),
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

  /** Run build-all to completion: until it resolves and has exited or summarised. */
  async function run() {
    await buildAll({});
    // Stop on an exit or on a summary, so a run that wrongly reports success
    // fails here at once instead of timing out.
    await waitFor(
      () => exitCodes.length > 0 || /Successfully built/.test(text()),
    );
  }

  const pkgDir = (name: string) => path.join(tmp, 'packages', name);

  it('failing leaf: reports it, still builds the rest, exits 1', async () => {
    makePackage(pkgDir('a'), '@probe/a', 'exit 2');
    makePackage(pkgDir('b'), '@probe/b', 'echo built');

    await run();

    expect(exitCodes).toEqual([1]);
    expect(text()).toMatch(/Failed to build: .*@probe\/a/);
    expect(text()).toMatch(/Built @probe\/b/);
    expect(text()).not.toMatch(/Built @probe\/a/);
    expect(text()).not.toMatch(/Successfully built: .*@probe\/a/);
  }, 30000);

  it('exits 1 when the only package fails', async () => {
    makePackage(pkgDir('a'), '@probe/a', 'exit 2');

    await run();

    expect(exitCodes).toEqual([1]);
    expect(text()).toMatch(/Failed to build: .*@probe\/a/);
  }, 30000);

  it('failing package with dependents: skips and reports them, builds everything else, finishes and exits 1', async () => {
    makePackage(pkgDir('a'), '@probe/a', 'exit 2');
    // b depends on a, c depends on b: neither can be built.
    makePackage(pkgDir('b'), '@probe/b', 'echo built', {'@probe/a': '1.0.0'});
    makePackage(pkgDir('c'), '@probe/c', 'echo built', {'@probe/b': '1.0.0'});
    // d is independent, e depends on d: both must still be built.
    makePackage(pkgDir('d'), '@probe/d', 'echo built');
    makePackage(pkgDir('e'), '@probe/e', 'echo built', {'@probe/d': '1.0.0'});

    await run();

    // Exits once, at the end, after the summary.
    expect(exitCodes).toEqual([1]);
    expect(text()).toMatch(/Built @probe\/d/);
    expect(text()).toMatch(/Built @probe\/e/);
    expect(text()).not.toMatch(/Built @probe\/[abc]\b/);
    expect(text()).toMatch(/Failed to build: .*@probe\/a/);
    expect(text()).toMatch(/@probe\/b.*: not built because @probe\/a failed/);
    expect(text()).toMatch(/@probe\/c.*: not built because @probe\/a failed/);
    expect(text()).toMatch(/1 failed and 2 not built, out of 5 packages/);
    expect(text()).not.toMatch(/CYCLICAL/);
  }, 30000);

  it('two independent failures: reports both and exits 1', async () => {
    makePackage(pkgDir('a'), '@probe/a', 'exit 2');
    makePackage(pkgDir('b'), '@probe/b', 'exit 3');
    makePackage(pkgDir('c'), '@probe/c', 'echo built');

    await run();

    expect(exitCodes).toEqual([1]);
    const failedLine = text()
      .split('\n')
      .find((l) => /Failed to build:/.test(l));
    expect(failedLine).toMatch(/@probe\/a/);
    expect(failedLine).toMatch(/@probe\/b/);
    expect(text()).toMatch(/Built @probe\/c/);
    expect(text()).toMatch(/2 failed and 0 not built, out of 3 packages/);
  }, 30000);

  it('does not exit non-zero when every package builds', async () => {
    makePackage(pkgDir('a'), '@probe/a', 'echo built');
    makePackage(pkgDir('b'), '@probe/b', 'echo built', {'@probe/a': '1.0.0'});

    await run();

    expect(exitCodes).toEqual([]);
    expect(text()).toMatch(/Successfully built: .*@probe\/a/);
    expect(text()).toMatch(/Successfully built: .*@probe\/b/);
    expect(text()).not.toMatch(/Failed to build|not built/);
  }, 30000);
});
