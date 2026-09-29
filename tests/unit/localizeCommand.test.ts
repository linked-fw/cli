/**
 * `linked localize` is a thin adapter over `@_linked/localize`. The only
 * behaviour it owns is which of that package's four entry points a given set
 * of flags reaches, and the build seam — `@_linked/localize` deliberately has
 * no opinion about how to build a checkout, and this CLI supplies
 * `linked build`. Those are what is asserted here; the cloning, symlinking and
 * manifest handling are covered by localize's own suite.
 */
const calls: {fn: string; args: any[]}[] = [];

jest.mock(
  '@_linked/localize',
  () => ({
    defaultDeps: (appRoot: string) => ({appRoot}),
    localize: (...args: any[]) => {
      calls.push({fn: 'localize', args});
      return 0;
    },
    delocalize: (...args: any[]) => {
      calls.push({fn: 'delocalize', args});
      return 0;
    },
    list: (...args: any[]) => {
      calls.push({fn: 'list', args});
      return 0;
    },
    relink: (...args: any[]) => {
      calls.push({fn: 'relink', args});
      return 0;
    },
  }),
  {virtual: true},
);

import {
  DEFAULT_BUILD_COMMAND,
  runDelocalize,
  runLocalize,
} from '../../src/commands/localize';

beforeEach(() => {
  calls.length = 0;
  process.exitCode = undefined;
});

afterAll(() => {
  process.exitCode = undefined;
});

describe('linked localize', () => {
  it('reports rather than localizing when given no package names', async () => {
    await runLocalize([], {});
    expect(calls.map((c) => c.fn)).toEqual(['list']);
    expect(calls[0].args[0]).toEqual({check: undefined});
  });

  it('passes --check through to list', async () => {
    await runLocalize([], {list: true, check: true});
    expect(calls[0].fn).toBe('list');
    expect(calls[0].args[0]).toEqual({check: true});
  });

  it('takes --relink before anything else, since that is the postinstall path', async () => {
    await runLocalize(['@_linked/rdfs'], {relink: true, list: true});
    expect(calls.map((c) => c.fn)).toEqual(['relink']);
  });

  it('supplies `linked build` as the build command localize itself will not guess', async () => {
    await runLocalize(['@_linked/rdfs'], {});
    expect(calls[0].fn).toBe('localize');
    expect(calls[0].args[0]).toEqual(['@_linked/rdfs']);
    expect(calls[0].args[1].build).toBe(DEFAULT_BUILD_COMMAND);
  });

  it('lets --build override the default, and an empty value mean no build', async () => {
    await runLocalize(['lodash'], {build: 'npm run compile'});
    expect(calls[0].args[1].build).toBe('npm run compile');

    calls.length = 0;
    await runLocalize(['lodash'], {build: ''});
    expect(calls[0].args[1].build).toBe('');
  });

  it('forwards the checkout options verbatim', async () => {
    await runLocalize(['@scope/pkg'], {
      dir: 'vendor',
      repo: 'git@example.com:me/pkg.git',
      subdir: 'packages/pkg',
      force: true,
    });
    expect(calls[0].args[1]).toMatchObject({
      dir: 'vendor',
      repo: 'git@example.com:me/pkg.git',
      subdir: 'packages/pkg',
      force: true,
    });
  });

  it('reports failure through the exit code instead of throwing', async () => {
    await runLocalize([], {});
    expect(process.exitCode).toBe(0);
  });
});

describe('linked delocalize', () => {
  it('undoes every localized package when given no names', async () => {
    await runDelocalize([], {});
    expect(calls[0].fn).toBe('delocalize');
    expect(calls[0].args[0]).toEqual([]);
  });

  it('passes --purge and --force through', async () => {
    await runDelocalize(['@_linked/rdfs'], {purge: true, force: true});
    expect(calls[0].args[1]).toEqual({purge: true, force: true});
  });
});
