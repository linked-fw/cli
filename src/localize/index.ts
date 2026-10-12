/**
 * localize's programmatic API: `linked localize` / `linked delocalize` (see
 * `commands/localize.ts`, the commander adapter) and `create-package`'s adopt
 * reach it through here.
 *
 * Every command takes `deps` -- `{appRoot, run, log, warn, error}` -- so a
 * caller can point it at another root or capture its output. `defaultDeps()`
 * builds the normal one.
 */
export {
  localize,
  runLocalize,
  installAndBuild,
  buildCommandFor,
  DEFAULT_BUILD_COMMAND,
  CLI_PACKAGE,
  CLI_BUILD_COMMAND,
  INSTALL_ARGS,
  REPOS_DIR,
  LEGACY_MANIFEST,
  LOCKFILE,
  SETUP_LOCK_ARGS,
} from './localize.js';
export type {LocalizeOptions, Prepared, Prepare} from './localize.js';
export {adopt, localizeParked} from './adopt.js';
export {delocalize} from './delocalize.js';
export {list, collect} from './list.js';
export type {ListRow} from './list.js';
export {DRIFT_COMMANDS, installDriftHook, reportDrift} from './drift-hook.js';
export type {Resolved} from './resolve.js';
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
export {HOOK_MARKER, GIT_HOOKS, installGitHooks, hookLine} from './git-hooks.js';
export type {GitHook, HookInstall, ManualHook} from './git-hooks.js';
export {findAppRoot, findWorkspaceRoot} from './app-root.js';
export {resolvePackage, normalizeGitUrl, checkoutNameFor} from './resolve.js';
export {defaultDeps, makeRun} from './run.js';
export {
  LocalizeError,
  EXIT_DRIFT,
  EXIT_USAGE,
  EXIT_NOT_FOUND,
  EXIT_WARNED,
  EXIT_REFUSED,
  EXIT_INSTALL_FAILED,
} from './errors.js';
