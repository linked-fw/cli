// The Node CSS loader must name a package stylesheet the way the client does in
// the same run — dev names in development, production names otherwise — even
// though it runs on the module-hooks thread, which never sees the app's `.env`.
//
// The launched-process cases bundle the REAL `src/launch.ts` (with `cli.js`
// replaced by tests/fixtures/css-loader-mode/cli-stub.ts, which loads the env the
// CLI's way and then imports the app) and run it as the `linked` bin would run.
import {spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {build} from 'esbuild';
import {generateScopedName} from '../../src/utils';
import {generateScopedNameProduction} from '../../src/css-module-names';
import {cssNamingModeFor, resolveLoaderMode} from '../../src/loader-mode';

const repoRoot = path.resolve(__dirname, '..', '..');
const BUTTON_CSS = '.Root { display: flex; }\n.ring { opacity: 1; }\n';

/** An app with `ui-pkg` installed, as an externalised @_linked package ships. */
const createApp = (root: string, files: Record<string, string> = {}) => {
  const lib = path.join(root, 'node_modules', 'ui-pkg', 'lib', 'esm');
  fs.mkdirSync(lib, {recursive: true});
  fs.writeFileSync(path.join(lib, 'Button.module.css'), BUTTON_CSS);
  fs.writeFileSync(
    path.join(lib, 'Button.js'),
    `import styles from './Button.module.css';\nexport default styles;\n`,
  );
  fs.writeFileSync(
    path.join(root, 'node_modules', 'ui-pkg', 'package.json'),
    JSON.stringify({
      name: 'ui-pkg',
      type: 'module',
      exports: {'./*': './lib/esm/*'},
    }),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({name: 'probe-app', private: true, type: 'module'}),
  );
  fs.writeFileSync(
    path.join(root, 'main.js'),
    `import styles from 'ui-pkg/Button.js';\nexport default styles;\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  return path.join(lib, 'Button.module.css');
};

const namesFor = (mode: 'development' | 'production', cssFile: string) => {
  const name =
    mode === 'development' ? generateScopedName : generateScopedNameProduction;
  return {Root: name('Root', cssFile), ring: name('ring', cssFile)};
};

describe('CSS loader naming mode', () => {
  const roots: string[] = [];
  const tempRoot = () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-css-mode-')),
    );
    roots.push(dir);
    return dir;
  };
  // Bundled inside the repo so the loaders' bare imports resolve from its node_modules.
  const bundleDir = path.join(
    repoRoot,
    'node_modules',
    '.cache',
    `css-loader-mode-${process.pid}`,
  );
  const launch = path.join(bundleDir, 'launch.mjs');

  beforeAll(async () => {
    await build({
      entryPoints: {
        launch: path.join(repoRoot, 'src', 'launch.ts'),
        // `registerLoaders` is bundled into launch.mjs, so the loaders it
        // registers by relative URL sit next to it.
        'css-loader': path.join(repoRoot, 'src', 'loaders', 'css-loader.mts'),
        'ts-loader': path.join(repoRoot, 'src', 'loaders', 'ts-loader.mts'),
      },
      outdir: bundleDir,
      outExtension: {'.js': '.mjs'},
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      logLevel: 'silent',
      plugins: [
        {
          name: 'cli-stub',
          setup(b) {
            b.onResolve({filter: /^\.\/cli\.js$/}, () => ({
              path: path.join(
                repoRoot,
                'tests',
                'fixtures',
                'css-loader-mode',
                'cli-stub.ts',
              ),
            }));
          },
        },
      ],
    });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(bundleDir, {recursive: true, force: true});
    roots.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true}));
  });

  /** Launch the bin in `cwd` with `NODE_ENV` set in the shell only when given. */
  const runLaunch = (
    cwd: string,
    shellNodeEnv?: string,
    args: string[] = ['start'],
  ) => {
    const env = {...process.env};
    delete env.NODE_ENV;
    delete env.ENV_VARS_LOADED;
    if (shellNodeEnv !== undefined) env.NODE_ENV = shellNodeEnv;
    const result = spawnSync(process.execPath, [launch, ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    const line = result.stdout
      .split('\n')
      .find((l) => l.startsWith('@@RESULT@@'));
    if (!line) {
      throw new Error(
        `launch printed no result (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
      );
    }
    return JSON.parse(line.slice('@@RESULT@@'.length)) as {
      nodeEnv: string | null;
      styles: Record<string, string>;
    };
  };

  describe('a launched process', () => {
    it('gets the dev names when NODE_ENV=development comes only from .env', () => {
      const root = tempRoot();
      const css = createApp(root, {'.env': 'NODE_ENV=development\n'});
      const {nodeEnv, styles} = runLaunch(root);
      expect(nodeEnv).toBe('development');
      expect(styles).toEqual(namesFor('development', css));
      expect(styles.Root).not.toBe(generateScopedNameProduction('Root', css));
    }, 30_000);

    it('gets the production names when .env says production', () => {
      const root = tempRoot();
      const css = createApp(root, {'.env': 'NODE_ENV=production\n'});
      const {nodeEnv, styles} = runLaunch(root);
      expect(nodeEnv).toBe('production');
      expect(styles).toEqual(namesFor('production', css));
    }, 30_000);

    it('lets the shell override .env — production over a development file', () => {
      const root = tempRoot();
      const css = createApp(root, {'.env': 'NODE_ENV=development\n'});
      const {nodeEnv, styles} = runLaunch(root, 'production');
      expect(nodeEnv).toBe('production');
      expect(styles).toEqual(namesFor('production', css));
    }, 30_000);

    it('lets the shell override .env — development over a production file', () => {
      const root = tempRoot();
      const css = createApp(root, {'.env': 'NODE_ENV=production\n'});
      const {nodeEnv, styles} = runLaunch(root, 'development');
      expect(nodeEnv).toBe('development');
      expect(styles).toEqual(namesFor('development', css));
    }, 30_000);

    it('reads the --env profile of a legacy .env-cmdrc.json', () => {
      const root = tempRoot();
      const css = createApp(root, {
        '.env-cmdrc.json': JSON.stringify({
          _main: {NODE_ENV: 'production'},
          development: {NODE_ENV: 'development'},
          staging: {},
        }),
      });
      const dev = runLaunch(root, undefined, ['start', '--env', 'development']);
      expect(dev.nodeEnv).toBe('development');
      expect(dev.styles).toEqual(namesFor('development', css));

      const staging = runLaunch(root, undefined, ['start', '--env', 'staging']);
      expect(staging.nodeEnv).toBe('production');
      expect(staging.styles).toEqual(namesFor('production', css));
    }, 60_000);
  });

  describe('resolveLoaderMode', () => {
    const resolveIn = (
      files: Record<string, string>,
      env: NodeJS.ProcessEnv,
      args: string[],
    ) => {
      const root = tempRoot();
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(root, name), content);
      }
      return resolveLoaderMode({
        env,
        cwd: root,
        argv: ['node', 'linked', ...args],
      });
    };

    it('takes the shell first, then .env', () => {
      expect(
        resolveIn({'.env': 'NODE_ENV=development'}, {NODE_ENV: 'staging'}, [
          'start',
        ]),
      ).toEqual({
        nodeEnv: 'staging',
        source: 'shell',
        mode: 'production',
      });
      expect(
        resolveIn({'.env': '# c\nexport NODE_ENV="development"\n'}, {}, [
          'serve-app',
        ]),
      ).toEqual({
        nodeEnv: 'development',
        source: '.env',
        mode: 'development',
      });
    });

    it('ignores .env-cmdrc.json when a .env exists, as the CLI does', () => {
      const files = {
        '.env': 'PORT=4000\n',
        '.env-cmdrc.json': JSON.stringify({
          development: {NODE_ENV: 'development'},
        }),
      };
      expect(resolveIn(files, {}, ['serve-app']).source).toBe('unset');
    });

    it('defaults `start` to development, as the Vite dev server it runs does', () => {
      expect(resolveIn({}, {}, ['start'])).toEqual({
        nodeEnv: 'development',
        source: 'vite-default',
        mode: 'development',
      });
    });

    it('leaves other commands unset, which names production', () => {
      expect(resolveIn({}, {}, ['serve-app'])).toEqual({
        nodeEnv: undefined,
        source: 'unset',
        mode: 'production',
      });
    });

    it('gives the dev names to development only', () => {
      expect(cssNamingModeFor('development')).toBe('development');
      for (const value of ['production', 'staging', 'test', undefined]) {
        expect(cssNamingModeFor(value)).toBe('production');
      }
    });
  });
});
