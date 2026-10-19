import {resolveAppUrl} from '../../src/commands/start';

describe('resolveAppUrl', () => {
  test('uses the PORT the server listens on, not the configured port', () => {
    expect(resolveAppUrl({PORT: '4050'}, 4040)).toBe('http://localhost:4050/');
  });

  test('falls back to the configured port, then 4040', () => {
    expect(resolveAppUrl({}, 5000)).toBe('http://localhost:5000/');
    expect(resolveAppUrl({})).toBe('http://localhost:4040/');
  });
});
