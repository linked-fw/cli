import {resolveBuildTarget} from '../../src/app-release/resolve-build-target.js';

describe('resolveBuildTarget', () => {
  test('explicit web', () => {
    expect(resolveBuildTarget({target: 'web', appEnv: undefined})).toBe('web');
  });

  test('explicit capacitor', () => {
    expect(resolveBuildTarget({target: 'capacitor'})).toBe('capacitor');
  });

  test('APP_ENV=capacitor selects the native target', () => {
    expect(resolveBuildTarget({appEnv: 'capacitor'})).toBe('capacitor');
    expect(resolveBuildTarget({appEnv: ' Capacitor '})).toBe('capacitor');
  });

  test('default web', () => {
    expect(resolveBuildTarget({appEnv: undefined})).toBe('web');
  });

  test('conflicting web target', () => {
    expect(() =>
      resolveBuildTarget({target: 'web', appEnv: 'capacitor'}),
    ).toThrow('Cannot build target "web" while APP_ENV=capacitor');
  });

  test.each(['production', 'staging', 'true', '1', 'cn-production'])(
    'APP_ENV=%s builds web and does not hijack the target',
    (appEnv) => {
      expect(resolveBuildTarget({appEnv})).toBe('web');
      // ...and an explicit web target is not a conflict either.
      expect(resolveBuildTarget({target: 'web', appEnv})).toBe('web');
    },
  );

  test('invalid target', () => {
    expect(() => resolveBuildTarget({target: 'desktop' as 'web'})).toThrow(
      'Unknown app build target "desktop"',
    );
  });

  test.each(['', '0', 'false', 'NO', 'off'])(
    'empty or false-like APP_ENV value %p does not select capacitor',
    (appEnv) => {
      expect(resolveBuildTarget({appEnv})).toBe('web');
    },
  );
});
