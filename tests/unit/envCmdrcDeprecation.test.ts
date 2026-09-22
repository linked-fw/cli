import {envDeprecationNotices} from '../../src/lifecycle';

// `.env` is read first and wins outright, so adding one is how an app migrates
// off `.env-cmdrc.json`. The cost is that the profile file, and any `--env`
// name passed with it, then silently does nothing — hence the warning, and
// hence this test.

describe('envDeprecationNotices', () => {
  test('warns while an app still uses a profile file', () => {
    const notices = envDeprecationNotices({
      hasEnvCmdrc: true,
      hasDotEnv: false,
    });

    expect(notices[0]).toContain('.env-cmdrc.json is deprecated');
    expect(notices.join('\n')).toContain('`--env` goes away with it');
  });

  test('says so explicitly when a flat .env has taken over', () => {
    const notices = envDeprecationNotices({
      hasEnvCmdrc: true,
      hasDotEnv: true,
    });

    const text = notices.join('\n');
    expect(text).toContain('`.env` wins');
    expect(text).toContain('is being ignored entirely');
  });

  test('stays quiet for an app that already uses a flat .env', () => {
    expect(
      envDeprecationNotices({hasEnvCmdrc: false, hasDotEnv: true})
    ).toEqual([]);
  });

  test('stays quiet when there is no env file at all', () => {
    expect(
      envDeprecationNotices({hasEnvCmdrc: false, hasDotEnv: false})
    ).toEqual([]);
  });
});
