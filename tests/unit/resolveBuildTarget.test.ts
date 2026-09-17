import {resolveBuildTarget} from '../../src/app-release/resolve-build-target.js';

describe('resolveBuildTarget', () => {
  test('explicit web', () => {
    expect(resolveBuildTarget({target: 'web', appEnv: undefined})).toBe('web');
  });

  test('explicit capacitor', () => {
    expect(resolveBuildTarget({target: 'capacitor'})).toBe('capacitor');
  });

  test('legacy APP_ENV', () => {
    expect(resolveBuildTarget({appEnv: 'true'})).toBe('capacitor');
  });

  test('default web', () => {
    expect(resolveBuildTarget({appEnv: undefined})).toBe('web');
  });

  test('conflicting web target', () => {
    expect(() => resolveBuildTarget({target: 'web', appEnv: 'true'})).toThrow(
      'Cannot build target "web" while APP_ENV is enabled',
    );
  });

  test.each(['', '0', 'false', 'NO', 'off'])(
    'false-like APP_ENV value %p does not select capacitor',
    (appEnv) => {
      expect(resolveBuildTarget({appEnv})).toBe('web');
    },
  );
});

