import fs from 'fs';
import os from 'os';
import path from 'path';
import {doctorResolve} from '../../src/commands/doctor';

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

/** A package checkout with `src/`. */
function sourcePkg(dir: string, name: string) {
  writeJson(path.join(dir, 'package.json'), {name, version: '1.0.0', linkedPackage: true});
  fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {};');
}

function link(target: string, at: string) {
  fs.mkdirSync(path.dirname(at), {recursive: true});
  fs.symlinkSync(target, at, 'dir');
}

describe('linked doctor resolve', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-doctor-')));
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  it('main-checkout layout', async () => {
    const app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {
      name: 'app',
      workspaces: ['packages-local/*'],
      dependencies: {'@_linked/core': '^1.0.0'},
    });
    const core = path.join(app, 'packages-local', '_linked-core');
    sourcePkg(core, '@_linked/core');
    link(core, path.join(app, 'node_modules', '@_linked', 'core'));
    const rows = await doctorResolve(app);
    expect(rows).toEqual([
      {name: '@_linked/core', vite: core, node: core, bundled: true, flag: null},
    ]);
  });

  it('worktree overlay', async () => {
    // The main checkout's install: server is its checkout.
    const main = path.join(tmp, 'main');
    const mainServer = path.join(main, 'packages-local', '_linked-server');
    sourcePkg(mainServer, '@_linked/server');
    link(mainServer, path.join(main, 'node_modules', '@_linked', 'server'));
    // The worktree: its own server checkout, the main checkout's node_modules.
    const wt = path.join(tmp, 'wt');
    writeJson(path.join(wt, 'package.json'), {
      name: 'app',
      workspaces: ['packages-local/*'],
      dependencies: {'@_linked/server': '^1.0.0'},
    });
    const wtServer = path.join(wt, 'packages-local', '_linked-server');
    sourcePkg(wtServer, '@_linked/server');
    link(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
    const rows = await doctorResolve(wt);
    expect(rows).toEqual([
      {name: '@_linked/server', vite: wtServer, node: mainServer, bundled: true, flag: 'overlay'},
    ]);
  });

  it('bundled cli with a different root', async () => {
    const main = path.join(tmp, 'main');
    const mainCli = path.join(main, 'packages-local', '_linked-cli');
    sourcePkg(mainCli, '@_linked/cli');
    link(mainCli, path.join(main, 'node_modules', '@_linked', 'cli'));
    const wt = path.join(tmp, 'wt');
    writeJson(path.join(wt, 'package.json'), {name: 'app', workspaces: ['packages-local/*']});
    const wtCli = path.join(wt, 'packages-local', '_linked-cli');
    sourcePkg(wtCli, '@_linked/cli');
    link(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
    // Today the CLI is never bundled; a config that bundles it (as before) is flagged.
    expect((await doctorResolve(wt)).find((r) => r.name === '@_linked/cli')).toMatchObject({
      vite: 'external',
      flag: null,
    });
    const exitCode = process.exitCode;
    try {
      const rows = await doctorResolve(wt, {noExternal: ['@_linked/cli']});
      expect(rows.find((r) => r.name === '@_linked/cli')).toMatchObject({
        vite: wtCli,
        node: mainCli,
        flag: 'two-copies',
      });
      const {runDoctorResolve} = await import('../../src/commands/doctor');
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      process.exitCode = 0;
      await runDoctorResolve({}, {cwd: wt});
      expect(process.exitCode).toBe(0);
      await runDoctorResolve({}, {cwd: wt, noExternal: ['@_linked/cli']});
      expect(process.exitCode).toBe(1);
      log.mockRestore();
    } finally {
      process.exitCode = exitCode;
    }
  });

  it('--json', async () => {
    const app = path.join(tmp, 'app');
    writeJson(path.join(app, 'package.json'), {name: 'app', workspaces: ['packages-local/*']});
    const core = path.join(app, 'packages-local', '_linked-core');
    sourcePkg(core, '@_linked/core');
    link(core, path.join(app, 'node_modules', '@_linked', 'core'));
    const cwd = process.cwd();
    const lines: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((m) => void lines.push(String(m)));
    try {
      process.chdir(app);
      const {runDoctorResolve} = await import('../../src/commands/doctor');
      await runDoctorResolve({json: true});
    } finally {
      log.mockRestore();
      process.chdir(cwd);
    }
    const rows = JSON.parse(lines.join('\n'));
    expect(rows.length).toBe(1);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['bundled', 'flag', 'name', 'node', 'vite']);
    }
  });
});
