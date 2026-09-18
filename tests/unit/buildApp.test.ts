import fs from 'fs';
import os from 'os';
import path from 'path';
import type {IArtifactStore} from '@_linked/core/interfaces/IArtifactStore';
import {
  buildViteApp,
  loadStaticArtifactStore,
} from '../../src/commands/build-app';
import {createReleaseManifest} from '../../src/app-release/create-release-manifest';

const makeApp = () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-build-app-'));
  fs.mkdirSync(path.join(appRoot, 'public/bundles/.vite'), {recursive: true});
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({name: 'fixture-app', version: '1.2.3'}),
  );
  fs.writeFileSync(
    path.join(appRoot, 'public/bundles/app.12345678.js'),
    'console.log("fixture");',
  );
  fs.writeFileSync(
    path.join(appRoot, 'public/bundles/.vite/manifest.json'),
    JSON.stringify({'src/index.tsx': {file: 'app.12345678.js'}}),
  );
  return appRoot;
};

const store: IArtifactStore = {
  describeDestination: () => ({
    bucket: 'fixture-static',
    prefix: '1.2.3',
    endpoint: 'https://objects.example.test',
    publicBaseUrl: 'https://cdn.example.test/1.2.3',
  }),
  putArtifact: jest.fn(),
  statArtifact: jest.fn(),
};

const originalEnvironment = {...process.env};

afterEach(() => {
  process.env = {...originalEnvironment};
  jest.restoreAllMocks();
});

describe('buildViteApp', () => {
  it('builds frontend then backend, writes a manifest, and publishes', async () => {
    const appRoot = makeApp();
    process.env.NODE_ENV = 'staging';
    delete process.env.APP_ENV;
    const calls: string[] = [];
    const publish = jest.fn(async () => {
      calls.push('publish');
      return {
        releaseId: 'fixture',
        uploadedFiles: 2,
        uploadedBytes: 1,
        dryRun: false,
      };
    });

    await buildViteApp(
      {appRoot, environmentNames: ['cn-staging'], target: 'web'},
      {
        loadEnvironment: async () => {
          calls.push('environment');
        },
        buildFrontend: async () => {
          calls.push('frontend');
        },
        buildBackend: async () => {
          calls.push('backend');
          return true;
        },
        loadStorageConfig: async () => {
          calls.push('storage');
          return {staticFileStore: store};
        },
        loadPublishConfig: async () => ({}),
        createManifest: (options) =>
          createReleaseManifest({...options, sourceRevision: 'abc123def456'}),
        publish,
      },
    );

    expect(calls).toEqual([
      'environment',
      'frontend',
      'backend',
      'storage',
      'publish',
    ]);
    expect(
      fs.existsSync(path.join(appRoot, 'public/bundles/linked-release.json')),
    ).toBe(true);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({appRoot, store, yes: true}),
    );
  });

  it('does not continue after a frontend build failure', async () => {
    const backend = jest.fn(async () => true);
    const publish = jest.fn();

    await expect(
      buildViteApp(
        {appRoot: makeApp(), target: 'web'},
        {
          loadEnvironment: async () => undefined,
          buildFrontend: async () => {
            throw new Error('vite failed');
          },
          buildBackend: backend,
          publish,
        },
      ),
    ).rejects.toThrow('vite failed');
    expect(backend).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not create or publish a release after backend failure', async () => {
    const appRoot = makeApp();
    const publish = jest.fn();
    await expect(
      buildViteApp(
        {appRoot, target: 'web'},
        {
          loadEnvironment: async () => undefined,
          buildFrontend: async () => undefined,
          buildBackend: async () => false,
          publish,
        },
      ),
    ).rejects.toThrow('Backend build did not complete successfully');
    expect(
      fs.existsSync(path.join(appRoot, 'public/bundles/linked-release.json')),
    ).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('skips storage and publishing in development', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_ENV;
    const loadStorageConfig = jest.fn();
    const publish = jest.fn();
    await buildViteApp(
      {appRoot: makeApp(), target: 'web'},
      {
        loadEnvironment: async () => undefined,
        buildFrontend: async () => undefined,
        buildBackend: async () => true,
        loadStorageConfig,
        publish,
      },
    );
    expect(loadStorageConfig).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects APP_ENV builds before publishing', async () => {
    process.env.APP_ENV = 'true';
    const publish = jest.fn();
    await expect(
      buildViteApp(
        {appRoot: makeApp()},
        {loadEnvironment: async () => undefined, publish},
      ),
    ).rejects.toThrow('Vite Capacitor build target is not ready yet');
    expect(publish).not.toHaveBeenCalled();
  });

  it('requires an explicitly exported static store', async () => {
    await expect(
      loadStaticArtifactStore(async () => ({uploadsFileStore: store})),
    ).rejects.toThrow('must export staticFileStore');
  });
});
