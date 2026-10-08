/**
 * `linked localize` is a thin commander adapter over `src/localize/`. The only
 * behaviour it owns is which of localize's four entry points a given set of
 * flags reaches, and the build seam — localize deliberately has no opinion
 * about how to build a checkout, and this CLI supplies `linked build`. Those
 * are what is asserted here; the cloning, symlinking and manifest handling are
 * covered by localize's own suites in `tests/unit/localize/`.
 */
const calls: {fn: string; args: any[]}[] = [];

jest.mock('../../src/localize/index', () => ({
  defaultDeps: (appRoot: string) => ({appRoot}),
  localize: (...args: any[]) => {
    calls.push({fn: 'localize', args});
    return 0;
  },
  adopt: (...args: any[]) => {
    calls.push({fn: 'adopt', args});
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
  reinstall: (...args: any[]) => {
    calls.push({fn: 'reinstall', args});
    return 7;
  },
  checkOneCopy: (...args: any[]) => {
    calls.push({fn: 'checkOneCopy', args});
    return {pruned: []};
  },
}));

import {
  adoptPackage,
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

// A checkout's own install leaves its own `@_linked/core` and a registry copy
// of any localized sibling in its node_modules; Node loads those instead of
// the app's. The CLI turns localize's pruning on for every path that installs
// or relinks; what the app provides is localize's own rule (provided.ts).
describe('linked localize prunes (on by default)', () => {
  const expected = {prune: true};

  it('is on for localize', async () => {
    await runLocalize(['@_linked/dcmi'], {});
    expect(calls[0].args[1]).toMatchObject(expected);
  });

  it('is on for --relink, the postinstall path, so a root install does not bring the copies back', async () => {
    await runLocalize([], {relink: true});
    expect(calls[0].fn).toBe('relink');
    expect(calls[0].args[1]).toEqual(expected);
  });

  it("is on for --adopt and for create-package's adopt", async () => {
    await runLocalize(['@_linked/fresh'], {adopt: true});
    expect(calls[0].args[1]).toMatchObject(expected);

    calls.length = 0;
    await adoptPackage('@_linked/fresh', {
      appRoot: '/app',
      build: 'linked build',
    });
    expect(calls[0].args[1]).toMatchObject(expected);
  });

  it('--no-prune turns it off everywhere', async () => {
    await runLocalize(['@_linked/dcmi'], {prune: false});
    expect(calls[0].args[1].prune).toBe(false);

    calls.length = 0;
    await runLocalize([], {relink: true, prune: false});
    expect(calls[0].args[1].prune).toBe(false);
  });
});

describe('linked localize --ensure / --reinstall', () => {
  it('--ensure runs the one-copy check at the app root and always exits 0', async () => {
    await runLocalize([], {ensure: true});
    expect(calls.map((c) => c.fn)).toEqual(['checkOneCopy']);
    expect(calls[0].args[0]).toBe(process.cwd());
    expect(process.exitCode).toBe(0);
  });

  it('--ensure --no-prune is a no-op: no check, exit 0', async () => {
    await runLocalize([], {ensure: true, prune: false});
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('--ensure with package names refuses (exit 2) rather than ignore them', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runLocalize(['@_linked/core'], {ensure: true});
      expect(calls).toEqual([]);
      expect(process.exitCode).toBe(2);
      expect(String(error.mock.calls[0][0])).toMatch(
        /--ensure takes no package names.*--reinstall <package>/,
      );
    } finally {
      error.mockRestore();
    }
  });

  it('--reinstall <pkg> reaches reinstall with the prune options, and reports its exit code', async () => {
    await runLocalize([], {reinstall: '@_linked/core'});
    expect(calls.map((c) => c.fn)).toEqual(['reinstall']);
    expect(calls[0].args[0]).toBe('@_linked/core');
    expect(calls[0].args[1]).toEqual({prune: true});
    expect(process.exitCode).toBe(7);

    calls.length = 0;
    await runLocalize([], {reinstall: '@_linked/core', prune: false});
    expect(calls[0].args[1]).toEqual({prune: false});
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

  it('--adopt reaches adopt, with the same build seam and no subdir', async () => {
    await runLocalize(['@_linked/foo'], {
      adopt: true,
      repo: 'https://x/foo.git',
    });
    expect(calls.map((c) => c.fn)).toEqual(['adopt']);
    expect(calls[0].args[0]).toEqual(['@_linked/foo']);
    expect(calls[0].args[1]).toEqual({
      force: undefined,
      dir: undefined,
      repo: 'https://x/foo.git',
      build: DEFAULT_BUILD_COMMAND,
      prune: true,
    });
  });

  it('adoptPackage returns the exit code instead of setting it', async () => {
    const code = await adoptPackage('@_linked/foo', {
      appRoot: '/app',
      build: 'node launch.js build',
    });
    expect(code).toBe(0);
    expect(process.exitCode).toBeUndefined();
    expect(calls[0].args[1]).toEqual({
      build: 'node launch.js build',
      repo: undefined,
      prune: true,
    });
    expect(calls[0].args[2]).toEqual({appRoot: '/app'});
  });

  it('--adopt refuses no names and --subdir instead of falling through', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await runLocalize([], {adopt: true});
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await runLocalize(['@_linked/foo'], {adopt: true, subdir: 'x'});
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
    err.mockRestore();
  });
});
