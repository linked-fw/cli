/**
 * localize's programmatic API: `linked localize` / `linked delocalize` (see
 * `commands/localize.ts`, the commander adapter) and `create-package`'s adopt
 * reach it through here.
 *
 * Every function takes `deps` -- `{appRoot, run, log, warn, error}` -- so a
 * caller can point it at another root or capture its output. `defaultDeps()`
 * builds the normal one.
 */
export {localize} from './localize.js';
export {adopt} from './adopt.js';
export {delocalize} from './delocalize.js';
export {list, collect} from './list.js';
export {relink} from './relink.js';
export {pruneProvided, shouldPrune} from './prune.js';
export type {PruneOptions, PruneScope} from './prune.js';
export {providedPackages} from './provided.js';
export type {Provided, ProvidedSkip} from './provided.js';
export {ensure, reinstall, checkOneCopy} from './ensure.js';
export type {LocalizeOptions} from './localize.js';
export type {ListRow} from './list.js';
export type {Resolved} from './resolve.js';
export type {Manifest, ManifestEntry} from './manifest.js';
export type {Deps, Run, RunOptions, RunResult} from './run.js';
export {satisfies} from './semver.js';
export {LOCAL_DIR, PARKED_DIR, localMembers, parkedMembers} from './members.js';
export type {Member} from './members.js';
export {SINGLETONS, driftProblems, describeDrift} from './drift.js';
export type {Drift} from './drift.js';
export {
  ensureAppSetup,
  conflictingOverrides,
  LOCK_AT_REST_COMMAND,
  WORKSPACE_GLOB,
} from './app-setup.js';
export type {SetupChange} from './app-setup.js';
export {HOOK_MARKER, GIT_HOOKS, installGitHooks} from './git-hooks.js';
export {resolvePackage, normalizeGitUrl, checkoutNameFor} from './resolve.js';
export {
  readManifest,
  writeManifest,
  manifestPath,
  MANIFEST_FILENAME,
  SCHEMA_VERSION,
  DEFAULT_DIR,
} from './manifest.js';
export {defaultDeps, makeRun} from './run.js';
export {
  LocalizeError,
  EXIT_BAD_FILE,
  EXIT_NOT_FOUND,
  EXIT_WARNED,
  EXIT_REFUSED,
  EXIT_INSTALL_FAILED,
  EXIT_MANIFEST_DIRTY,
} from './errors.js';
