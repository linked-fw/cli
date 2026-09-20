import type {AppBuildTarget} from './types.js';

export interface ResolveBuildTargetOptions {
  target?: AppBuildTarget;
  appEnv?: string;
}

/** The only `APP_ENV` value that selects a native build. */
const CAPACITOR_APP_ENV = 'capacitor';

/**
 * Resolve the app build target.
 *
 * `APP_ENV` selects the Capacitor target only when it literally says
 * `capacitor`. It used to be read as a boolean — any non-empty value meant
 * "native" — which quietly hijacked the far more common `APP_ENV=production`
 * into a near-empty, non-publishable manifest, and then made `--target web`
 * fail outright. Nothing else in this monorepo reads `APP_ENV`, so there is no
 * boolean contract left to preserve; an unrelated value is ignored and the
 * build defaults to web, exactly as it does with `APP_ENV` unset. Pass
 * `--target` to be explicit.
 */
export const resolveBuildTarget = ({
  target,
  appEnv = process.env.APP_ENV,
}: ResolveBuildTargetOptions = {}): AppBuildTarget => {
  if (target !== undefined && target !== 'web' && target !== 'capacitor') {
    throw new Error(
      `Unknown app build target "${String(target)}". Expected "web" or "capacitor".`,
    );
  }
  const isCapacitorEnvironment =
    (appEnv || '').trim().toLowerCase() === CAPACITOR_APP_ENV;

  // An explicit web target cannot silently override an explicit
  // `APP_ENV=capacitor`, because that would make a native build publishable.
  if (target === 'web' && isCapacitorEnvironment) {
    throw new Error(
      'Cannot build target "web" while APP_ENV=capacitor. Unset APP_ENV or use --target capacitor.',
    );
  }

  if (target) {
    return target;
  }

  return isCapacitorEnvironment ? 'capacitor' : 'web';
};
