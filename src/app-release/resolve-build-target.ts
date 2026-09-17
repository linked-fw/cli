import type {AppBuildTarget} from './types.js';

export interface ResolveBuildTargetOptions {
  target?: AppBuildTarget;
  appEnv?: string;
}

const isTruthyEnvironmentValue = (value: string | undefined): boolean => {
  if (value === undefined) {
    return false;
  }

  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
};

/**
 * Resolve the app build target while preserving the legacy APP_ENV contract.
 * An explicit web target cannot override APP_ENV because doing so could make a
 * native build publishable by mistake.
 */
export const resolveBuildTarget = ({
  target,
  appEnv = process.env.APP_ENV,
}: ResolveBuildTargetOptions = {}): AppBuildTarget => {
  const isCapacitorEnvironment = isTruthyEnvironmentValue(appEnv);

  if (target === 'web' && isCapacitorEnvironment) {
    throw new Error(
      'Cannot build target "web" while APP_ENV is enabled. Remove APP_ENV or use --target capacitor.',
    );
  }

  if (target) {
    return target;
  }

  return isCapacitorEnvironment ? 'capacitor' : 'web';
};

