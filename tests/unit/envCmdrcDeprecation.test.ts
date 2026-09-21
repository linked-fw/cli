import {envDeprecationNotices} from '../../src/lifecycle';

// `.env-cmdrc.json` is read before `.env` and wins outright, so an app that has
// added a flat `.env` alongside it sees none of it. Nothing says so at runtime
// — hence the warning, and hence this test.

describe('envDeprecationNotices', () => {
  test('warns while an app still uses a profile file', () => {
    const notices = envDeprecationNotices({
      hasEnvCmdrc: true,
      hasDotEnv: false,
    });

    expect(notices[0]).toContain('.env-cmdrc.json is deprecated');
    expect(notices.join('\n')).toContain('`--env` goes away with it');
  });

  test('says so explicitly when a .env is present and being ignored', () => {
    const notices = envDeprecationNotices({
      hasEnvCmdrc: true,
      hasDotEnv: true,
    });

    expect(notices.join('\n')).toContain('`.env` is being ignored entirely');
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
