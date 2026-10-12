/**
 * `linked localize` is a thin commander adapter over `src/localize/`. The only
 * behaviour it owns is which of localize's entry points a given set of flags
 * reaches, the usage refusals, and the two deprecated no-op flags. Those are
 * what is asserted here; cloning, installing, parking and drift are covered by
 * localize's own suites in `tests/unit/localize/`.
 */
const calls: {fn: string; args: any[]}[] = [];

jest.mock('../../src/localize/index', () => {
  const record =
    (fn: string, code = 0) =>
    (...args: any[]) => {
      calls.push({fn, args});
      return code;
    };
  return {
    DEFAULT_BUILD_COMMAND: 'linked build',
    defaultDeps: (appRoot: string) => ({appRoot}),
    localize: record('localize'),
    adopt: record('adopt'),
    localizeParked: record('localizeParked'),
    delocalize: record('delocalize', 7),
    list: record('list'),
  };
});

import {
  adoptPackage,
  ENSURE_HINT,
  runDelocalize,
  runLocalize,
} from '../../src/commands/localize';

let errors: jest.SpyInstance;
let logs: jest.SpyInstance;

beforeEach(() => {
  calls.length = 0;
  process.exitCode = undefined;
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  logs = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  logs.mockRestore();
});

afterAll(() => {
  process.exitCode = undefined;
});

describe('linked localize', () => {
  it('reports rather than localizing when given no package names', async () => {
    await runLocalize([], {});
    expect(calls.map((c) => c.fn)).toEqual(['list']);
    expect(calls[0].args[0]).toEqual({check: undefined});
    expect(process.exitCode).toBe(0);
  });

  it('passes --check through to list', async () => {
    await runLocalize([], {list: true, check: true});
    expect(calls[0].fn).toBe('list');
    expect(calls[0].args[0]).toEqual({check: true});
  });

  it('leaves the build to localize unless --build says, and an empty value means no build', async () => {
    await runLocalize(['@_linked/rdfs'], {});
    expect(calls[0].fn).toBe('localize');
    expect(calls[0].args[0]).toEqual(['@_linked/rdfs']);
    expect(calls[0].args[1].build).toBeUndefined();

    calls.length = 0;
    await runLocalize(['lodash'], {build: 'npm run compile'});
    expect(calls[0].args[1].build).toBe('npm run compile');

    calls.length = 0;
    await runLocalize(['lodash'], {build: ''});
    expect(calls[0].args[1].build).toBe('');
  });

  it('forwards the checkout options verbatim', async () => {
    await runLocalize(['@scope/pkg'], {
      dir: 'packages-local',
      repo: 'git@example.com:me/pkg.git',
      subdir: 'packages/pkg',
    });
    expect(calls[0].args[1]).toEqual({
      dir: 'packages-local',
      build: undefined,
      repo: 'git@example.com:me/pkg.git',
      subdir: 'packages/pkg',
    });
  });

  it('--parked reaches localizeParked and refuses names', async () => {
    await runLocalize([], {parked: true});
    expect(calls.map((c) => c.fn)).toEqual(['localizeParked']);

    calls.length = 0;
    await runLocalize(['@_linked/core'], {parked: true});
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
  });
});

describe('linked localize --relink / --ensure (deprecated)', () => {
  it('--relink exits 0 with no output and runs nothing', async () => {
    await runLocalize(['@_linked/rdfs'], {relink: true, list: true});
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });

  it('--ensure exits 0 with one hint line on stderr, names or not', async () => {
    await runLocalize(['@_linked/core'], {ensure: true});
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toBe(ENSURE_HINT);
    expect(ENSURE_HINT).not.toMatch(/\n/);
    expect(logs).not.toHaveBeenCalled();
  });
});

describe('linked localize --adopt', () => {
  it('reaches adopt with the build seam', async () => {
    await runLocalize(['@_linked/foo'], {adopt: true});
    expect(calls.map((c) => c.fn)).toEqual(['adopt']);
    expect(calls[0].args[0]).toEqual(['@_linked/foo']);
    expect(calls[0].args[1]).toEqual({dir: undefined, build: undefined});
  });

  it('refuses no names, --subdir and --repo instead of falling through', async () => {
    for (const opts of [{}, {subdir: 'x'}, {repo: 'https://x/foo.git'}]) {
      process.exitCode = undefined;
      await runLocalize(Object.keys(opts).length ? ['@_linked/foo'] : [], {
        adopt: true,
        ...opts,
      });
      expect(calls).toEqual([]);
      expect(process.exitCode).toBe(2);
    }
  });

  it('adoptPackage returns the exit code instead of setting it', async () => {
    const code = await adoptPackage('@_linked/foo', {
      appRoot: '/app',
      build: 'node launch.js build',
    });
    expect(code).toBe(0);
    expect(process.exitCode).toBeUndefined();
    expect(calls[0].args[1]).toEqual({build: 'node launch.js build'});
    expect(calls[0].args[2]).toEqual({appRoot: '/app'});
  });
});

describe('linked delocalize', () => {
  it('parks every checkout when given no names, and reports the exit code', async () => {
    await runDelocalize([], {});
    expect(calls[0].fn).toBe('delocalize');
    expect(calls[0].args[0]).toEqual([]);
    expect(process.exitCode).toBe(7);
  });

  it('passes --purge and --force through', async () => {
    await runDelocalize(['@_linked/rdfs'], {purge: true, force: true});
    expect(calls[0].args[1]).toEqual({purge: true, force: true});
  });
});
