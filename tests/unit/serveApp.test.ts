import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  serveCompiledApp,
  validateCompiledAppArtifacts,
} from '../../src/commands/serve-app.js';

describe('serveCompiledApp', () => {
  let appRoot: string;
  const originalNodeEnv = process.env.NODE_ENV;

  const write = (relativePath: string, content = 'export default {};') => {
    const absolutePath = path.join(appRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
    fs.writeFileSync(absolutePath, content);
  };

  beforeEach(() => {
    appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-serve-'));
    process.env.NODE_ENV = 'staging';
    write('lib/App.js');
    write('lib/routes.js');
    write('lib/backend.js');
    write(
      'public/bundles/.vite/manifest.json',
      JSON.stringify({'src/index.tsx': {file: 'assets/app.js'}}),
    );
  });

  afterEach(() => {
    fs.rmSync(appRoot, {recursive: true, force: true});
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  test('starts the compiled server after environment load and validation', async () => {
    const calls: string[] = [];
    await expect(
      serveCompiledApp(
        {appRoot},
        {
          loadEnvironment: async () => { calls.push('environment'); },
          startCompiledServer: async () => { calls.push('server'); return 'started'; },
        },
      ),
    ).resolves.toBe('started');
    expect(calls).toEqual(['environment', 'server']);
  });

  test('does not need a Vite factory to start', async () => {
    const viteFactory = jest.fn(() => { throw new Error('Vite initialized'); });
    await serveCompiledApp(
      {appRoot},
      {loadEnvironment: async () => {}, startCompiledServer: async () => 'ok'},
    );
    expect(viteFactory).not.toHaveBeenCalled();
  });

  test.each(['lib/App.js', 'lib/routes.js', 'lib/backend.js'])(
    'fails clearly when %s is missing',
    async (relativePath) => {
      fs.rmSync(path.join(appRoot, relativePath));
      await expect(
        serveCompiledApp(
          {appRoot},
          {loadEnvironment: async () => {}, startCompiledServer: async () => {}},
        ),
      ).rejects.toThrow(`Compiled app artifact is missing: ${relativePath}`);
    },
  );

  test('fails before listening when the Vite manifest is missing', async () => {
    fs.rmSync(path.join(appRoot, 'public/bundles/.vite/manifest.json'));
    const start = jest.fn();
    await expect(
      serveCompiledApp(
        {appRoot},
        {loadEnvironment: async () => {}, startCompiledServer: start},
      ),
    ).rejects.toThrow('public/bundles/.vite/manifest.json');
    expect(start).not.toHaveBeenCalled();
  });

  test('rejects an empty Vite manifest', () => {
    write('public/bundles/.vite/manifest.json', '{}');
    expect(() => validateCompiledAppArtifacts(appRoot)).toThrow(
      'manifest.json is empty',
    );
  });

  test('refuses development mode and directs users to linked start', async () => {
    process.env.NODE_ENV = 'development';
    await expect(
      serveCompiledApp(
        {appRoot},
        {loadEnvironment: async () => {}, startCompiledServer: async () => {}},
      ),
    ).rejects.toThrow('Use linked start for development');
  });

  test('validates after the selected environment is loaded', async () => {
    delete process.env.NODE_ENV;
    await serveCompiledApp(
      {appRoot},
      {
        loadEnvironment: async () => { process.env.NODE_ENV = 'staging'; },
        startCompiledServer: async () => 'ok',
      },
    );
    expect(process.env.NODE_ENV).toBe('staging');
  });
});
