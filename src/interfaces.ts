export interface PackageDetails {
  path: string;
  packageName: string;
}

/** CSS processing for server-side rendering in development. */
export type CssMode = 'tailwind' | 'postcss';

/** Which provider methods `/call` reaches: every one (with a warning) or only declared ones. */
export type RpcExposureMode = 'warn' | 'enforce';

/** Raw SPARQL on `/api/select-raw`: off for everyone, or for a signed-in session. */
export type RawQueriesMode = 'off' | 'session';

/** The server's settings, as `linked.app.json` holds them under `server`. */
export interface AppServerSettings {
  /**
   * `enforce`: only provider methods declared callable are reachable over `/call`, every other
   * one answers 501. `warn` (the server's default) runs them with a warning.
   * `LINKED_RPC_EXPOSURE`, when set, wins over this.
   */
  rpcExposure?: RpcExposureMode;
  /** Raw SPARQL on `/api/select-raw`: `off`, or `session` (the server's default). */
  rawQueries?: RawQueriesMode;
  /**
   * Serve only the backend API (`/call/...`, `/api/...` and provider routes): no server-side page
   * rendering, so page requests get a 404. `linked start --api-only` sets this.
   * @default false
   */
  apiOnly?: boolean;
  /** Paths whose server-side rendered pages are cached in memory. */
  cachePaths?: string[];
  /**
   * Milliseconds a cached page is served before it is rendered again.
   * @default 300000 (5 minutes)
   */
  cacheTimeout?: number;
}

/** The server configuration the cli gives `LinkedServer`: the app's settings and its load hooks. */
export interface LinkedServerConfig extends AppServerSettings {
  /**
   * Loads the app component (server-side rendering, hot reloading). Set by the cli: `src/App`
   * (`lib/App.js` in a compiled server), or the Vite SSR runner's copy.
   */
  loadAppComponent?: () => any;
  /** Loads the app's routes module (server-side preloading). Set by the cli, like the app component. */
  loadRoutes?: () => Promise<any>;
}

/** The configuration the cli gives `LinkedServer`, built from the app's `linked.app.json`. */
export interface LinkedConfig {
  cssMode?: CssMode;
  /**
   * Materialize the app's registered shapes into its data store as SHACL on boot.
   * @default true
   */
  syncShapesOnBoot?: boolean;
  server?: LinkedServerConfig;
}
