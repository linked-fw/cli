// Quick test for `create-app --template react-native`.
// Scaffolds the hand-made fixture template in tests/fixtures/ — no network.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import semver from 'semver';

// ora is ESM-only, which Jest's CommonJS loader cannot require.
jest.mock('ora', () => {
  const spinner = {start: () => spinner, succeed() {}, fail() {}};
  return {__esModule: true, default: () => spinner};
});

jest.mock('../../src/utils.js', () => {
  const actual = jest.requireActual('../../src/utils.js');
  return {...actual, execPromise: jest.fn(() => Promise.resolve(''))};
});

import {execPromise} from '../../src/utils.js';
import {
  createApp,
  reactNativeBundleId,
  reactNativeInternals,
  scaffoldReactNativeApp,
} from '../../src/cli-methods.js';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'app-react-native-min');
const TEMPLATE = path.join(__dirname, '..', '..', 'defaults', 'app-react-native');
const ID = {
  appName: 'Demo',
  appPrefix: 'demo',
  appDomain: 'example.com',
  hyphenName: 'demo',
};

const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const findFiles = (dir: string, name: string): string[] =>
  fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return findFiles(full, name);
    return entry.name === name ? [full] : [];
  });

const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : listFiles(full);
    }
    return [full];
  });

let tmp: string;
let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-rn-'));
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  (execPromise as jest.Mock).mockClear();
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  jest.restoreAllMocks();
  fs.removeSync(tmp);
});

describe('reactNativeBundleId', () => {
  test('reverses the domain and appends the prefix', () => {
    expect(reactNativeBundleId('example.com', 'demo')).toBe(
      'com.example.demo',
    );
  });

  test('normalises scheme, case and trailing slash', () => {
    expect(reactNativeBundleId('https://Example.com/', 'demo')).toBe(
      'com.example.demo',
    );
  });

  test('keeps subdomains', () => {
    expect(reactNativeBundleId('app.example.com', 'demo')).toBe(
      'com.example.app.demo',
    );
  });

  test('replaces underscores, which a bundle ID does not allow', () => {
    expect(reactNativeBundleId('example.com', 'my_app')).toBe(
      'com.example.my-app',
    );
  });

  test('reactNativeBundleId strips port', () => {
    expect(reactNativeBundleId('localhost:3000', 'x')).toBe('com.localhost.x');
  });

  test('drops empty labels', () => {
    expect(reactNativeBundleId('https://a..b.com:8080/path', 'x')).toBe(
      'com.b.a.x',
    );
  });
});

describe('scaffoldReactNativeApp', () => {
  test('stamps identity into fixture', async () => {
    const target = path.join(tmp, 'demo');
    await scaffoldReactNativeApp(target, ID, {
      templateDir: FIXTURE,
      skipInstall: true,
    });

    expect(fs.existsSync(path.join(target, 'packages/demo-shapes'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(target, 'packages/app-shapes'))).toBe(false);

    const rootPkg = readJSON(path.join(target, 'package.json'));
    expect(rootPkg.workspaces).toContain('packages/demo-shapes');
    expect(rootPkg.workspaces).not.toContain('packages/app-shapes');

    const gitignore = path.join(target, '.gitignore');
    expect(fs.existsSync(gitignore)).toBe(true);
    expect(fs.readFileSync(gitignore, 'utf8')).toContain(
      '!packages/demo-shapes/',
    );
    expect(findFiles(target, 'gitignore.template')).toEqual([]);
    expect(fs.existsSync(path.join(target, 'apps/mobile/.gitignore'))).toBe(
      true,
    );

    const shapesPkg = readJSON(
      path.join(target, 'packages/demo-shapes/package.json'),
    );
    expect(shapesPkg.name).toBe('demo-shapes');

    expect(
      fs.readFileSync(
        path.join(target, 'packages/demo-shapes/src/package.ts'),
        'utf8',
      ),
    ).toContain("linkedPackage('demo-shapes')");

    const mobilePkg = readJSON(path.join(target, 'apps/mobile/package.json'));
    expect(mobilePkg.dependencies['demo-shapes']).toBeDefined();
    expect(mobilePkg.dependencies['app-shapes']).toBeUndefined();
    expect(mobilePkg.jest.transformIgnorePatterns[0]).toContain(
      'demo-shapes',
    );

    const appJson = readJSON(path.join(target, 'apps/mobile/app.json'));
    expect(appJson.expo.name).toBe('Demo');
    expect(appJson.expo.slug).toBe('demo');
    expect(appJson.expo.ios.bundleIdentifier).toBe('com.example.demo');

    expect(
      fs.readFileSync(path.join(target, 'apps/mobile/App.tsx'), 'utf8'),
    ).toContain("import { Example } from 'demo-shapes';");

    // Fuseki dataset tokens in a renamed nested dotfile.
    expect(
      fs.readFileSync(path.join(target, 'services/api/.env.example'), 'utf8'),
    ).toBe('FUSEKI_DATASET=demo-dev\n');
    // The template ships no CI workflow.
    expect(fs.existsSync(path.join(target, '.github'))).toBe(false);

    expect(fs.existsSync(path.join(target, 'yarn.lock'))).toBe(false);
  });

  test('real template, no install', async () => {
    const target = path.join(tmp, 'demo');
    await scaffoldReactNativeApp(target, ID, {skipInstall: true});

    expect(fs.existsSync(path.join(target, 'packages/demo-shapes'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(target, 'packages/app-shapes'))).toBe(false);

    const rootPkg = readJSON(path.join(target, 'package.json'));
    expect(rootPkg.name).toBe('demo-monorepo');
    expect(rootPkg.workspaces).toContain('packages/demo-shapes');
    expect(rootPkg.workspaces).not.toContain('packages/app-shapes');

    expect(fs.readFileSync(path.join(target, '.gitignore'), 'utf8')).toContain(
      '!packages/demo-shapes/',
    );
    expect(fs.existsSync(path.join(target, 'apps/mobile/.gitignore'))).toBe(
      true,
    );
    expect(findFiles(target, 'gitignore.template')).toEqual([]);

    expect(
      readJSON(path.join(target, 'packages/demo-shapes/package.json')).name,
    ).toBe('demo-shapes');
    expect(
      fs.readFileSync(
        path.join(target, 'packages/demo-shapes/src/package.ts'),
        'utf8',
      ),
    ).toContain("linkedPackage('demo-shapes')");

    const mobilePkg = readJSON(path.join(target, 'apps/mobile/package.json'));
    expect(mobilePkg.dependencies['demo-shapes']).toBeDefined();
    expect(mobilePkg.dependencies['app-shapes']).toBeUndefined();
    expect(mobilePkg.jest.transformIgnorePatterns[0]).toContain(
      'demo-shapes',
    );
    // Explicit pins: no reliance on npm auto-installing peers.
    expect(mobilePkg.dependencies['expo-dev-client']).toBeDefined();
    expect(mobilePkg.devDependencies['@react-native/jest-preset']).toBeDefined();

    // No root overrides: @_linked/react accepts React 19 from 1.5.0 on.
    expect(rootPkg.overrides).toBeUndefined();
    for (const script of ['fuseki:up', 'api', 'lint', 'typecheck', 'test', 'test:integration', 'check:react']) {
      expect(rootPkg.scripts[script]).toBeDefined();
    }
    expect(rootPkg.scripts.typecheck).toContain('packages/demo-shapes');
    // An exact pin (no range, no `*`) copied from the template, and never below the first release
    // that accepts React 19. The literal is not asserted: Renovate moves it on every framework bump.
    const linkedReact: string = mobilePkg.dependencies['@_linked/react'];
    expect(linkedReact).toBe(
      readJSON(path.join(TEMPLATE, 'apps/mobile/package.json')).dependencies['@_linked/react'],
    );
    expect(semver.valid(linkedReact)).toBe(linkedReact);
    expect(semver.gte(linkedReact, '1.5.0')).toBe(true);
    expect(mobilePkg.jest.testPathIgnorePatterns).toContain(
      '<rootDir>/__tests__/integration/',
    );

    // Identity stays in app.json; app.config.ts only adds the API URL.
    const appJson = readJSON(path.join(target, 'apps/mobile/app.json'));
    expect(appJson.expo.name).toBe('Demo');
    expect(appJson.expo.slug).toBe('demo');
    expect(appJson.expo.ios.bundleIdentifier).toBe('com.example.demo');

    for (const file of [
      'apps/mobile/app.config.ts',
      'apps/mobile/src/shell/env.ts',
      'apps/mobile/src/shell/storage.ts',
      'apps/mobile/src/shell/apiPort.json',
      'apps/mobile/src/components/PersonOverview.tsx',
      'apps/mobile/src/components/PersonPreview.tsx',
      'apps/mobile/src/components/PersonOverviewContext.tsx',
      'apps/mobile/__tests__/shapes.test.ts',
      'apps/mobile/__tests__/env.test.ts',
      'apps/mobile/__tests__/composePort.test.ts',
      'apps/mobile/__tests__/storage.test.ts',
      'apps/mobile/__tests__/stripJsonImportAttributes.test.ts',
      'apps/mobile/babel.config.js',
      'apps/mobile/babel/stripJsonImportAttributes.js',
      'apps/mobile/__tests__/nativeDefaults.test.tsx',
      'apps/mobile/__tests__/integration/personOverview.test.tsx',
      'apps/mobile/jest.integration.config.js',
      'packages/demo-shapes/src/shapes/Example.ts',
      'packages/demo-shapes/tsconfig-esm.json',
      'services/api/src/backend.ts',
      'services/api/linked.backend.storage.ts',
      'services/api/linked.backend.datasets.json',
      'services/api/scripts/wait-for-fuseki.mjs',
      'services/api/test/waitForFuseki.test.mjs',
      'services/api/.env.example',
      'docker-compose.yml',
      'eslint.config.js',
      'scripts/check-react.mjs',
    ]) {
      expect(fs.existsSync(path.join(target, file))).toBe(true);
    }
    expect(
      fs.existsSync(path.join(target, 'apps/mobile/src/shell/linkedDefaults.tsx')),
    ).toBe(false);
    const appTsx = fs.readFileSync(path.join(target, 'apps/mobile/App.tsx'), 'utf8');
    expect(appTsx).toContain("from 'demo-shapes'");

    // Load order is enforced by imports: render defaults first in App.tsx; storage pulls env; linked components
    // pull storage.
    expect(appTsx.match(/^import .*$/m)?.[0]).toBe("import '@_linked/react/native';");
    expect(appTsx).not.toContain("import './src/shell/storage'");
    expect(
      fs.readFileSync(path.join(target, 'apps/mobile/src/shell/storage.ts'), 'utf8'),
    ).toContain("import './env';");
    for (const component of ['PersonOverview', 'PersonPreview']) {
      expect(
        fs.readFileSync(path.join(target, `apps/mobile/src/components/${component}.tsx`), 'utf8'),
      ).toContain("import '../shell/storage';");
    }
    expect(readJSON(path.join(target, 'apps/mobile/src/shell/apiPort.json'))).toEqual({defaultApiPort: 4000});

    // Uploads land in services/api/data/, which is ignored; no NODE_ENV-files directory any more.
    const rootIgnore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
    expect(rootIgnore).toContain('services/api/data/');
    expect(rootIgnore).not.toContain('-files/');

    // The integration setup refuses a foreign Fuseki before it resets anything.
    const globalSetup = fs.readFileSync(
      path.join(target, 'apps/mobile/__tests__/integration/globalSetup.ts'),
      'utf8',
    );
    expect(globalSetup).toContain("['compose', 'port', 'fuseki', '3030']");
    expect(globalSetup).toContain('delete env.AWS_REGION');
    expect(globalSetup).toContain('INTEGRATION_API_BIN');

    const shapes = readJSON(path.join(target, 'packages/demo-shapes/package.json'));
    expect(shapes.linkedPackage).toBe(true);
    // Extensionless imports need no opt-in: `linked build` always rewrites the
    // emitted ESM specifiers.
    expect(shapes.linked).toBeUndefined();

    const apiPkg = readJSON(path.join(target, 'services/api/package.json'));
    expect(apiPkg.dependencies['demo-shapes']).toBe('*');
    expect(apiPkg.scripts.start).toContain('linked start --api-only');

    // Dataset names come from the prefix.
    expect(
      fs.readFileSync(path.join(target, 'services/api/.env.example'), 'utf8'),
    ).toContain('FUSEKI_DATASET=demo-dev');
    expect(
      fs.readFileSync(
        path.join(target, 'services/api/linked.backend.datasets.json'),
        'utf8',
      ),
    ).toContain('${FUSEKI_DATASET:-demo-dev}');
    expect(
      fs.readFileSync(
        path.join(target, 'apps/mobile/__tests__/integration/apiEnv.ts'),
        'utf8',
      ),
    ).toContain("'demo-test'");

    // Regression guard: no file may still name a placeholder token.
    const stillNamed = listFiles(target).filter((file) => {
      const buffer = fs.readFileSync(file);
      const text = buffer.toString('utf8');
      return (
        !buffer.includes(0) &&
        ['app-shapes', 'app-dev', 'app-test'].some((token) => text.includes(token))
      );
    });
    expect(stillNamed).toEqual([]);
    expect(listFiles(target).filter((file) => file.endsWith('.template'))).toEqual([]);
    expect(fs.existsSync(path.join(target, '.github'))).toBe(false);

    expect(findFiles(target, '.npmignore')).toEqual([]);
    expect(fs.existsSync(path.join(target, 'yarn.lock'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'data'))).toBe(false);
  });

  test('leaves template literals alone', async () => {
    const template = path.join(tmp, 'template');
    fs.copySync(FIXTURE, template);
    const literal = 'const s = `${name}-${hyphen_name}`;\n';
    fs.writeFileSync(path.join(template, 'apps/mobile/literal.ts'), literal);

    const target = path.join(tmp, 'demo');
    await scaffoldReactNativeApp(target, ID, {
      templateDir: template,
      skipInstall: true,
    });

    expect(
      fs.readFileSync(path.join(target, 'apps/mobile/literal.ts'), 'utf8'),
    ).toBe(literal);
  });
});

describe('scaffoldReactNativeApp refusals', () => {
  test.each(['my app', 'c++', 'App', '1x', ''])(
    'rejects invalid prefix %j',
    async (appPrefix) => {
      const target = path.join(tmp, 'demo');
      await expect(
        scaffoldReactNativeApp(
          target,
          {...ID, appPrefix},
          {templateDir: FIXTURE, skipInstall: true},
        ),
      ).rejects.toThrow('^[a-z][a-z0-9-]*$');
      expect(fs.readdirSync(tmp)).toEqual([]);
    },
  );

  test('rejects non-empty target', async () => {
    const target = path.join(tmp, 'demo');
    const file = path.join(target, 'file.txt');
    fs.mkdirSync(target);
    fs.writeFileSync(file, 'app-shapes keep me\n');

    await expect(
      scaffoldReactNativeApp(target, ID, {
        templateDir: FIXTURE,
        skipInstall: true,
      }),
    ).rejects.toThrow(/not empty/);
    expect(fs.readdirSync(target)).toEqual(['file.txt']);
    expect(fs.readFileSync(file, 'utf8')).toBe('app-shapes keep me\n');
  });

  test('install failure rejects', async () => {
    (execPromise as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('boom'), {stdout: '', stderr: ''})),
    );
    const target = path.join(tmp, 'demo');

    await expect(
      scaffoldReactNativeApp(target, ID, {templateDir: FIXTURE}),
    ).rejects.toThrow(/npm install/);
    expect(execPromise).toHaveBeenCalledWith(
      'npm install',
      false,
      false,
      expect.objectContaining({cwd: target}),
    );
    // Files stay on disk so the user can retry the install.
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
  });
});

describe('createApp', () => {
  test('rejects unknown template', async () => {
    await createApp('x', tmp, {
      template: 'android' as any,
      appName: 'X',
      appPrefix: 'x',
      appDomain: 'x.com',
      skipInstall: true,
    });

    expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
    expect(warnSpy.mock.calls.flat().join(' ')).toContain(
      'Unknown template "android". Use "web" or "react-native".',
    );
  });

  test('react-native path skips web post-steps', async () => {
    const scaffold = jest
      .spyOn(reactNativeInternals, 'scaffoldReactNativeApp')
      .mockResolvedValue(undefined);

    await createApp('x', tmp, {
      template: 'react-native',
      appName: 'X',
      appPrefix: 'x',
      appDomain: 'x.com',
      skipInstall: true,
    });

    expect(scaffold).toHaveBeenCalledTimes(1);
    expect(scaffold.mock.calls[0][1]).toMatchObject({hyphenName: 'x'});
    const commands = (execPromise as jest.Mock).mock.calls.map((c) => c[0]);
    expect(commands.some((c) => /git clone/.test(c))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'x', 'data'))).toBe(false);
  });
});
