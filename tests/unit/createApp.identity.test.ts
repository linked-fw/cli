// `create-app` stamps the new app's identity into the template clone. The app is a
// linkedApp, not a linked package: its root registers no package, so nothing under
// src/ is rewritten — only package.json, the env files and the process names.
//
// cli-methods pulls in ora, which is ESM-only.
jest.mock('ora', () => ({__esModule: true, default: () => ({})}));

import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {applyAppIdentity} from '../../src/cli-methods';

describe('applyAppIdentity', () => {
  let app: string;

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-identity-'));
    fs.outputJsonSync(path.join(app, 'package.json'), {name: 'app', displayName: 'Template'});
    fs.outputFileSync(path.join(app, '.env.example'), 'APP_NAME=Linked App Template\nAPP_PREFIX=app\n');
    fs.outputFileSync(path.join(app, 'pm2.config.js'), `module.exports = {apps: [{name: 'app'}]};\n`);
  });

  afterEach(() => {
    fs.removeSync(app);
  });

  test('rewrites package.json name, the env files and the process name', () => {
    applyAppIdentity(app, {appName: 'My Shop', appPrefix: 'shop', hyphenName: 'my-shop'});

    const pkg = fs.readJsonSync(path.join(app, 'package.json'));
    expect(pkg.name).toBe('my-shop');
    expect(pkg.displayName).toBe('My Shop');
    expect(pkg.linkedPackage).toBeUndefined();
    expect(fs.readFileSync(path.join(app, '.env.example'), 'utf8')).toContain('APP_NAME=My Shop');
    expect(fs.readFileSync(path.join(app, '.env'), 'utf8')).toContain('APP_PREFIX=shop');
    expect(fs.readFileSync(path.join(app, 'pm2.config.js'), 'utf8')).toContain(`name: 'my-shop'`);
  });

  test('leaves src/ alone: the app root registers no package', () => {
    // A clone of a template that still ships a root registration: it is not the
    // app's identity, so it is neither rewritten nor given the app's name.
    const packageTs = path.join(app, 'src', 'package.ts');
    const before = `export const {linkedShape} = linkedPackage('app');\n`;
    fs.outputFileSync(packageTs, before);

    applyAppIdentity(app, {appName: 'My Shop', appPrefix: 'shop', hyphenName: 'my-shop'});

    expect(fs.readFileSync(packageTs, 'utf8')).toBe(before);
  });
});
