// `create-app` scaffolds every app with npm — no yarn branch, no prompt.
// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => {
  const spinner = {start: () => spinner, succeed() {}, fail() {}};
  return {__esModule: true, default: () => spinner};
});

import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import {
  CREATE_APP_PACKAGE_MANAGER,
  installCommandFor,
  startCommandFor,
  stripYarnProjectFiles,
} from '../../src/cli-methods.js';

describe('create-app package manager', () => {
  test('scaffolds with npm', () => {
    expect(CREATE_APP_PACKAGE_MANAGER).toBe('npm');
  });

  test('the install command for the scaffolded app is a plain npm install', () => {
    const command = installCommandFor(CREATE_APP_PACKAGE_MANAGER);
    expect(command).toBe('npm install');
    expect(command).not.toMatch(/yarn/);
  });

  test('the next-steps command is npm start', () => {
    const command = startCommandFor(CREATE_APP_PACKAGE_MANAGER);
    expect(command).toBe('npm start');
    expect(command).not.toMatch(/yarn/);
  });

  test('the yarn commands stay available for callers that ask for them', () => {
    expect(installCommandFor('yarn')).toContain('yarn install');
    expect(startCommandFor('yarn')).toBe('yarn start');
  });
});

describe('scaffold is left yarn-free', () => {
  test('every yarn project file is removed from the clone', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-scaffold-'));
    fs.outputFileSync(path.join(app, 'yarnrc.yml.template'), 'nodeLinker: "node-modules"\n');
    fs.outputFileSync(path.join(app, '.yarnrc.yml'), 'yarnPath: .yarn/releases/yarn-3.6.1.cjs\n');
    fs.outputFileSync(path.join(app, '.yarn/releases/yarn-3.6.1.cjs'), '// yarn');
    fs.outputFileSync(path.join(app, 'yarn.lock'), '');
    fs.outputFileSync(path.join(app, 'package.json'), '{}');

    stripYarnProjectFiles(app);

    for (const leftover of ['yarnrc.yml.template', '.yarnrc.yml', '.yarn', 'yarn.lock']) {
      expect(fs.existsSync(path.join(app, leftover))).toBe(false);
    }
    // ...and nothing else is touched.
    expect(fs.existsSync(path.join(app, 'package.json'))).toBe(true);

    fs.removeSync(app);
  });
});
