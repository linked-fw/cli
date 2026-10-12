/**
 * localize's programmatic API: `linked localize` / `linked delocalize` (see
 * `commands/localize.ts`, the commander adapter) and `create-package`'s adopt
 * reach it through here.
 *
 * Every command takes `deps` -- `{appRoot, run, log, warn, error}` -- so a
 * caller can point it at another root or capture its output. `defaultDeps()`
 * builds the normal one.
 */
export {localize, DEFAULT_BUILD_COMMAND} from './localize.js';
export type {LocalizeOptions} from './localize.js';
export {adopt, localizeParked} from './adopt.js';
export {delocalize} from './delocalize.js';
export {list, collect} from './list.js';
export type {ListRow} from './list.js';
export {driftProblems, describeDrift, satisfies} from './drift.js';
export type {Drift} from './drift.js';
export {LOCAL_DIR, PARKED_DIR, localMembers, parkedMembers} from './members.js';
export type {Member} from './members.js';
export {ensureAppSetup} from './app-setup.js';
export type {SetupChange} from './app-setup.js';
export {findAppRoot} from './app-root.js';
export {resolvePackage, normalizeGitUrl, checkoutNameFor} from './resolve.js';
export type {Resolved} from './resolve.js';
export {defaultDeps, makeRun} from './run.js';
export type {Deps, Run, RunOptions, RunResult} from './run.js';
export {
  LocalizeError,
  EXIT_DRIFT,
  EXIT_USAGE,
  EXIT_NOT_FOUND,
  EXIT_WARNED,
  EXIT_REFUSED,
  EXIT_INSTALL_FAILED,
} from './errors.js';
