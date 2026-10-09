export interface ModuleConfig {
  internals?: string[] | '*';
  entry?: string;
  filename?: string;
  declarations?: boolean;
  internalsources?: string[];
  externals?: {[npmModule: string]: string};
  target?: 'es5' | 'es6';
  es5?: ModuleConfig;
  es6?: ModuleConfig;
  dev?: ModuleConfig;
  prod?: ModuleConfig;
  debug?: boolean;
  alias?: {[oldNpmPath: string]: string};
  provide?: {};
  environment?: 'nodejs' | 'browser' | 'polymorphic';
  outputPath?: string;
  bundlePath?: string;
  es5Server?: boolean;
  analyse?: boolean;
  cssIdentName?: string;
  beforeBuildCommand?: string;
  afterBuildCommand?: string;
  afterBuildCommandProduction?: string;
  afterFirstBuildCommand?: string;
  cssGlobalModulePaths?: string;
  cssMode?: 'tailwind' | 'postcss';
  cssFileName?: string;
  //used to overwrite tsConfig settings of the usual build process
  tsConfigOverwrites?: Object;
}

export interface AdjustedModuleConfig extends ModuleConfig {
  watch?: boolean;
  productionMode?: boolean;
}

export interface PackageDetails {
  path: string;
  packageName: string;
}

/**
 * Server-specific configuration
 */
export interface LinkedServerConfig {
  /**
   * Paths to cache for server-side rendering (SSR)
   * Cached pages will be served from memory for faster response times
   */
  cachePaths?: string[];

  /**
   * Cache timeout in milliseconds for SSR rendered pages
   * After this time, cached pages will be re-rendered
   * @default 300000 (5 minutes)
   */
  cacheTimeout?: number;

  /**
   * Enable multi-core server processing (requires @semantu/multicore)
   * Spawns worker processes to handle requests across multiple CPU cores
   * @default false
   */
  multiCore?: boolean;

  /**
   * Function that loads the app component (for SSR and hot reloading)
   * Must be a function to support hot module reloading
   */
  loadAppComponent?: () => any;

  /**
   * Function that loads the app routes configuration (for SSR preloading)
   * Must be a function to support hot module reloading
   * Should return a RoutesModule from 'lincd-server'
   */
  loadRoutes?: () => Promise<any>;

  /**
   * Serve only the backend API (`/call/...`, `/api/...` and provider routes):
   * no server-side page rendering, so page requests get a 404.
   * `linked start --api-only` sets this.
   * @default false
   */
  apiOnly?: boolean;
}

/**
 * Complete Linked configuration
 */
export interface LinkedConfig {
  /**
   * CSS processing mode (shared by the Vite build and the server for SSR)
   * - 'tailwind': Use Tailwind CSS v4 via the @tailwindcss/vite plugin. Still supports CSS Modules for .module.css files
   * - 'postcss': Use PostCSS with nesting support and CSS Modules for .module.css files
   * @default 'postcss'
   */
  cssMode?: 'tailwind' | 'postcss';

  /**
   * Server configuration
   */
  server?: LinkedServerConfig;

  /**
   * Materialize this app's registered shapes into its data store as SHACL
   * (`sh:NodeShape`) on boot — so its app-data holds the shapes its instances
   * validate/query against. Runs in LinkedServer.start()/initOnly().
   * @default true
   * Set `false` for a server whose default dataset is a context-router (e.g. CN),
   * or an app that manages its own shape/dataset lifecycle.
   */
  syncShapesOnBoot?: boolean;
}
