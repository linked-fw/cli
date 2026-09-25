// Quick tests for `linked start --api-only`: how the Vite dev server and
// LinkedServer are configured for a backend with no web frontend.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  configureLinkedServer,
  isApiOnly,
  resolveLinkedConfigPath,
  resolveViteServerConfig,
} from '../../src/commands/start.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-start-'));
});

afterEach(() => {
  fs.removeSync(cwd);
});

const fakeVite = () => ({
  middlewares: {} as any,
  ssrLoadModule: jest.fn(async (url: string) => ({default: url})),
});

describe('isApiOnly', () => {
  test('is off by default', () => {
    expect(isApiOnly({}, {server: {}})).toBe(false);
  });

  test('is on with the --api-only flag', () => {
    expect(isApiOnly({apiOnly: true}, {server: {}})).toBe(true);
  });

  test('is on with server.apiOnly in linked.config.js', () => {
    expect(isApiOnly({}, {server: {apiOnly: true}})).toBe(true);
  });

  test('is never inferred from missing frontend files', () => {
    // An empty cwd has no vite.config, App.tsx or routes.tsx.
    expect(isApiOnly({}, {})).toBe(false);
  });
});

describe('resolveLinkedConfigPath', () => {
  test('finds the current linked.config.js name', () => {
    fs.writeFileSync(path.join(cwd, 'linked.config.js'), 'export default {};');
    expect(resolveLinkedConfigPath(cwd)).toBe(path.join(cwd, 'linked.config.js'));
  });

  test('falls back to the legacy lincd.config.js name', () => {
    fs.writeFileSync(path.join(cwd, 'lincd.config.js'), 'export default {};');
    expect(resolveLinkedConfigPath(cwd)).toBe(path.join(cwd, 'lincd.config.js'));
  });

  test('prefers the current name when both exist', () => {
    fs.writeFileSync(path.join(cwd, 'linked.config.js'), 'export default {};');
    fs.writeFileSync(path.join(cwd, 'lincd.config.js'), 'export default {};');
    expect(resolveLinkedConfigPath(cwd)).toBe(path.join(cwd, 'linked.config.js'));
  });

  test('with no config at all, returns a path that does not exist', () => {
    const resolved = resolveLinkedConfigPath(cwd);
    expect(resolved).toBe(path.join(cwd, 'linked.config.js'));
    expect(fs.existsSync(resolved)).toBe(false);
  });

  test('a legacy config still drives server.apiOnly', () => {
    // The fallback must not cost an app its whole `server` block — the config
    // this path resolves is what isApiOnly() reads.
    fs.writeFileSync(path.join(cwd, 'lincd.config.js'), 'export default {};');
    expect(resolveLinkedConfigPath(cwd)).toBe(path.join(cwd, 'lincd.config.js'));
    expect(isApiOnly({}, {server: {apiOnly: true}})).toBe(true);
  });
});

describe('resolveViteServerConfig', () => {
  test('lets Vite load an existing vite.config file', async () => {
    fs.writeFileSync(path.join(cwd, 'vite.config.ts'), 'export default {};');
    for (const apiOnly of [false, true]) {
      const config = await resolveViteServerConfig(cwd, apiOnly);
      expect(config).toEqual({
        root: cwd,
        server: {middlewareMode: true},
        appType: 'custom',
      });
    }
  });

  test('without a vite.config, page mode fails and points at --api-only', async () => {
    await expect(resolveViteServerConfig(cwd, false)).rejects.toThrow(
      /no vite\.config[\s\S]*--api-only/,
    );
  });

  test('without a vite.config, API-only mode uses the linked defaults inline', async () => {
    const config = await resolveViteServerConfig(cwd, true);
    expect(config.configFile).toBe(false);
    expect(config.root).toBe(cwd);
    expect(config.appType).toBe('custom');
    expect(config.server?.middlewareMode).toBe(true);
    // Decorators in shape packages need the linked esbuild settings.
    expect((config.esbuild as any).tsconfigRaw.compilerOptions.experimentalDecorators).toBe(
      true,
    );
    expect(config.ssr?.noExternal).toBeDefined();
    // There is no client entry to scan for browser dependencies.
    expect(config.optimizeDeps?.noDiscovery).toBe(true);
    // 60s, not jest's default 5s: this is the first thing in the suite to touch
    // ../vite-config.js, whose cold load pulls in vite, @vitejs/plugin-react and
    // tailwind — well over 5s on a cold module cache.
  }, 60_000);
});

describe('configureLinkedServer', () => {
  test('API-only hands over Vite without page rendering hooks', () => {
    const server: any = {cachePaths: ['/']};
    const vite = fakeVite();
    configureLinkedServer(server, vite, cwd, true);
    expect(server.vite).toBe(vite);
    expect(server.apiOnly).toBe(true);
    expect(server.viteMiddleware).toBeUndefined();
    expect(server.loadAppComponent).toBeUndefined();
    expect(server.loadRoutes).toBeUndefined();
    expect(server.viteSsrPreload).toBeUndefined();
    expect(server.cachePaths).toEqual(['/']);
  });

  test('page mode loads App, routes and pages through Vite', async () => {
    fs.outputFileSync(path.join(cwd, 'src', 'pages', 'Home.tsx'), '');
    fs.outputFileSync(path.join(cwd, 'src', 'pages', 'style.css'), '');
    const server: any = {};
    const vite = fakeVite();
    configureLinkedServer(server, vite, cwd, false);
    expect(server.apiOnly).toBeUndefined();
    expect(server.viteMiddleware).toBe(vite.middlewares);
    expect(await server.loadAppComponent()).toBe('/src/App.tsx');
    expect(await server.loadRoutes()).toEqual({default: '/src/routes.tsx'});
    expect(await server.viteSsrPreload()).toEqual(['/src/pages/Home.tsx']);
  });

  test('page discovery skips tests, specs and type declarations', async () => {
    for (const name of [
      'Home.tsx',
      'Home.test.tsx',
      'Home.spec.ts',
      'pages.d.ts',
      'style.css',
    ]) {
      fs.outputFileSync(path.join(cwd, 'src', 'pages', name), '');
    }
    const server: any = {};
    configureLinkedServer(server, fakeVite(), cwd, false);
    expect(await server.viteSsrPreload()).toEqual(['/src/pages/Home.tsx']);
  });
});
