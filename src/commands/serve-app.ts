import fs from 'fs';
import path from 'path';
import {ensureEnvironmentLoaded} from '../lifecycle.js';

export interface ServeAppOptions {
  appRoot?: string;
  allowDevelopment?: boolean;
  /** Profiles from `--env a,b`, passed on to the environment loader. */
  environmentNames?: string[];
}

export interface ServeAppDependencies {
  loadEnvironment?: () => Promise<void>;
  startCompiledServer?: () => Promise<unknown>;
}

const requiredBuildArtifacts = [
  'lib/App.js',
  'lib/routes.js',
  'lib/backend.js',
  'public/bundles/.vite/manifest.json',
];

export const validateCompiledAppArtifacts = (appRoot: string): void => {
  for (const relativePath of requiredBuildArtifacts) {
    const absolutePath = path.join(appRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `Compiled app artifact is missing: ${relativePath}. Run linked build-app before linked serve-app.`,
      );
    }
  }

  const manifestPath = path.join(
    appRoot,
    'public/bundles/.vite/manifest.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Object.keys(manifest).length === 0) {
    throw new Error(
      'Compiled app artifact is invalid: public/bundles/.vite/manifest.json is empty',
    );
  }
};

/** Start a compiled Linked backend without creating a Vite server or watcher. */
export const serveCompiledApp = async (
  options: ServeAppOptions = {},
  dependencies: ServeAppDependencies = {},
): Promise<unknown> => {
  const appRoot = options.appRoot || process.cwd();
  const loadEnvironment =
    dependencies.loadEnvironment ||
    (() => ensureEnvironmentLoaded(options.environmentNames));
  const startCompiledServer =
    dependencies.startCompiledServer ||
    (async () => {
      const {startServer} = await import('../cli-methods.js');
      return startServer(false);
    });

  await loadEnvironment();

  if (process.env.NODE_ENV === 'development' && !options.allowDevelopment) {
    throw new Error(
      'linked serve-app only runs compiled non-development builds. Use linked start for development.',
    );
  }

  validateCompiledAppArtifacts(appRoot);
  return startCompiledServer();
};
