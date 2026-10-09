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
// fails the run.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(root: string, name: string, build: string) {
  writeJson(path.join(root, 'package.json'), {
    name,
    version: '1.0.0',
    linkedPackage: true,
    scripts: {build},
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

  it('reports the failed package and exits 1', async () => {
    makePackage(path.join(tmp, 'packages', 'a'), '@probe/a', 'exit 2');
    makePackage(path.join(tmp, 'packages', 'b'), '@probe/b', 'echo built');

    buildAll({});
    // Stop on an exit or on a summary, so a run that wrongly reports success
    // fails here at once instead of timing out.
    await waitFor(
      () => exitCodes.length > 0 || /Successfully built/.test(text()),
    );

    expect(exitCodes[0]).toBe(1);
    expect(text()).toMatch(/Failed to build: .*@probe\/a/);
    expect(text()).not.toMatch(/Built @probe\/a/);
    expect(text()).not.toMatch(/Successfully built: .*@probe\/a/);
  }, 30000);

  it('exits 1 when the only package fails', async () => {
    makePackage(path.join(tmp, 'packages', 'a'), '@probe/a', 'exit 2');

    buildAll({});
    // Stop on an exit or on a summary, so a run that wrongly reports success
    // fails here at once instead of timing out.
    await waitFor(
      () => exitCodes.length > 0 || /Successfully built/.test(text()),
    );

    expect(exitCodes[0]).toBe(1);
    expect(text()).toMatch(/Failed to build: .*@probe\/a/);
  }, 30000);

  it('does not exit non-zero when every package builds', async () => {
    makePackage(path.join(tmp, 'packages', 'a'), '@probe/a', 'echo built');
    makePackage(path.join(tmp, 'packages', 'b'), '@probe/b', 'echo built');

    buildAll({});
    await waitFor(() => /Successfully built/.test(text()));

    expect(exitCodes).not.toContain(1);
    expect(text()).not.toMatch(/Failed to build/);
  }, 30000);
});
