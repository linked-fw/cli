import path from 'path';
import {pathToFileURL} from 'url';
import {
  createLinkedFileMatcher,
  createPackageFileMatcher,
  installDualCopyGuard,
  type RegisterHooks,
} from '../../src/utils/dual-copy-guard';

const STANDALONE = [
  /^@_linked\/server-utils$/,
  /^@_linked\/react$/,
  '@_linked/server',
];
const url = (file: string) => pathToFileURL(file).href;
const APP = path.resolve('/app');
const NM = (rel: string) => url(path.join(APP, 'node_modules', rel));
const IMPORTER = NM('@_linked/schema/lib/esm/shapes/ImageObject.class.js');

// A packages-local checkout as CN has it: the realpath of
// node_modules/@_linked/server-utils, with a nameless lib/esm/package.json.
const LOCAL = path.resolve('/cn/packages-local/_linked-server-utils');
const PACKAGE_NAMES: Record<string, string> = {
  [path.resolve('/cn')]: '@semantu/create-now',
  [LOCAL]: '@_linked/server-utils',
  [path.resolve('/cn/packages-local/_linked-cli')]: '@_linked/cli',
  [path.resolve('/cn/packages-local/_linked-fuseki')]: '@_linked/fuseki',
};

function fakeReadPackageName() {
  const calls: string[] = [];
  const read = (dir: string) => {
    calls.push(dir);
    return PACKAGE_NAMES[dir] ?? null;
  };
  return {read, calls};
}

/** Installs the guard with a fake registerHooks; `resolve(spec, url)` drives the hook. */
function setup(
  noExternal: Parameters<typeof installDualCopyGuard>[0]['noExternal'],
) {
  const reports: string[] = [];
  const logs: string[] = [];
  let hook: Parameters<RegisterHooks>[0]['resolve'] | undefined;
  const registerHooks: RegisterHooks = (hooks) => {
    hook = hooks.resolve;
  };
  const {read, calls} = fakeReadPackageName();
  const status = installDualCopyGuard({
    noExternal,
    env: {},
    registerHooks,
    report: (l) => reports.push(l),
    log: (l) => logs.push(l),
    readPackageName: read,
  });
  const resolve = (specifier: string, resolved: string, parent = IMPORTER) => {
    if (!hook) throw new Error('hook not registered');
    return hook(specifier, {parentURL: parent}, () => ({url: resolved}));
  };
  return {status, reports, logs, resolve, calls};
}

describe('createLinkedFileMatcher', () => {
  it('matches a node_modules file by its path', () => {
    const match = createLinkedFileMatcher(() => null);
    expect(match(NM('@_linked/server-utils/lib/esm/utils/Server.js'))).toEqual({
      name: '@_linked/server-utils',
      subpath: 'lib/esm/utils/Server.js',
    });
  });

  it('uses the innermost node_modules and ignores non-linked packages', () => {
    const match = createLinkedFileMatcher(() => '@_linked/never');
    expect(
      match(NM('@_linked/schema/node_modules/@_linked/react/lib/esm/x.js')),
    ).toEqual({name: '@_linked/react', subpath: 'lib/esm/x.js'});
    expect(match(NM('react/index.js'))).toBeNull();
    expect(match(NM('@_linked/react/node_modules/react/index.js'))).toBeNull();
  });

  it('ignores URLs that are not files', () => {
    const match = createLinkedFileMatcher(() => '@_linked/x');
    expect(match('node:fs')).toBeNull();
    expect(match('data:text/javascript,1')).toBeNull();
  });

  it('matches a localized checkout by the nearest named package.json', () => {
    const {read} = fakeReadPackageName();
    const match = createLinkedFileMatcher(read);
    expect(match(url(path.join(LOCAL, 'lib/esm/utils/Server.js')))).toEqual({
      name: '@_linked/server-utils',
      subpath: 'lib/esm/utils/Server.js',
    });
  });

  it('does not match a file of a non-linked package outside node_modules', () => {
    const {read} = fakeReadPackageName();
    const match = createLinkedFileMatcher(read);
    expect(match(url(path.resolve('/cn/src/backend.ts')))).toBeNull();
    expect(match(url(path.resolve('/elsewhere/x.js')))).toBeNull();
  });

  it('reads each directory once', () => {
    const {read, calls} = fakeReadPackageName();
    const match = createLinkedFileMatcher(read);
    match(url(path.join(LOCAL, 'lib/esm/utils/Server.js')));
    match(url(path.join(LOCAL, 'lib/esm/utils/ShapeProvider.js')));
    match(url(path.join(LOCAL, 'lib/esm/index.js')));
    expect(calls.length).toBe(new Set(calls).size);
    expect(calls).toEqual([
      path.join(LOCAL, 'lib/esm/utils'),
      path.join(LOCAL, 'lib/esm'),
      path.join(LOCAL, 'lib'),
      LOCAL,
    ]);
  });
});

describe('installDualCopyGuard', () => {
  it('reports a node_modules file of a bundled package with the contract line', () => {
    const g = setup(STANDALONE);
    const file = NM('@_linked/server-utils/lib/esm/utils/Server.js');
    expect(g.resolve('@_linked/server-utils/utils/Server', file)).toEqual({
      url: file,
    });
    expect(g.reports).toEqual([
      '[linked] TWO COPIES: Node loaded @_linked/server-utils/lib/esm/utils/Server.js ' +
        `(imported as "@_linked/server-utils/utils/Server" from ${IMPORTER}), ` +
        'but @_linked/server-utils is bundled for the Vite SSR runner. ' +
        'Classes from it will fail `instanceof` and its module state exists twice.',
    ]);
  });

  it('reports a localized checkout file of a bundled package', () => {
    const g = setup(['@_linked/server-utils']);
    g.resolve(
      '@_linked/server-utils/utils/Server',
      url(path.join(LOCAL, 'lib/esm/utils/Server.js')),
    );
    expect(g.reports).toHaveLength(1);
    expect(g.reports[0]).toContain(
      'Node loaded @_linked/server-utils/lib/esm/utils/Server.js',
    );
  });

  it('does not report an external package', () => {
    const g = setup(STANDALONE);
    g.resolve(
      '@_linked/fuseki/shapes/FusekiStore',
      NM('@_linked/fuseki/lib/esm/shapes/FusekiStore.js'),
    );
    g.resolve('@_linked/core', NM('@_linked/core/lib/esm/index.js'));
    g.resolve(
      '@_linked/fuseki/shapes/FusekiStore',
      url(
        path.resolve(
          '/cn/packages-local/_linked-fuseki/lib/esm/shapes/FusekiStore.js',
        ),
      ),
    );
    expect(g.reports).toEqual([]);
  });

  it('never reports the CLI, even when everything is bundled', () => {
    const g = setup(true);
    g.resolve(
      '@_linked/cli/vite-config',
      NM('@_linked/cli/lib/esm/vite-config.js'),
    );
    g.resolve(
      './utils/x.js',
      url(path.resolve('/cn/packages-local/_linked-cli/lib/esm/utils/x.js')),
    );
    expect(g.reports).toEqual([]);
  });

  it('treats noExternal true as every package bundled', () => {
    const g = setup(true);
    g.resolve(
      '@_linked/fuseki/shapes/FusekiStore',
      NM('@_linked/fuseki/lib/esm/shapes/FusekiStore.js'),
    );
    g.resolve('react', NM('react/index.js'));
    expect(g.reports).toHaveLength(1);
    expect(g.reports[0]).toContain(
      'Node loaded @_linked/fuseki/lib/esm/shapes/FusekiStore.js',
    );
  });

  it('accepts a single string or RegExp noExternal and reports nothing without one', () => {
    const file = NM('@_linked/react/lib/esm/utils/ClassNames.js');
    const one = setup('@_linked/react');
    one.resolve('@_linked/react/utils/ClassNames', file);
    expect(one.reports).toHaveLength(1);
    const re = setup(/^@_linked\/react$/);
    re.resolve('@_linked/react/utils/ClassNames', file);
    expect(re.reports).toHaveLength(1);
    const none = setup(undefined);
    none.resolve('@_linked/react/utils/ClassNames', file);
    expect(none.reports).toEqual([]);
  });

  it('reports each file once, whatever its importer', () => {
    const g = setup(STANDALONE);
    const file = NM('@_linked/react/lib/esm/utils/ClassNames.js');
    g.resolve('@_linked/react/utils/ClassNames', file);
    g.resolve(
      '@_linked/react/utils/ClassNames',
      file,
      NM('@_linked/primitives/lib/esm/components/Button.js'),
    );
    g.resolve(
      './ClassNames.js',
      file,
      NM('@_linked/react/lib/esm/utils/LinkedComponent.js'),
    );
    g.resolve(
      '@_linked/react/utils/LinkedComponent',
      NM('@_linked/react/lib/esm/utils/LinkedComponent.js'),
    );
    expect(g.reports).toHaveLength(2);
  });

  it('passes non-file results through untouched', () => {
    const g = setup(true);
    expect(g.resolve('node:fs', 'node:fs')).toEqual({url: 'node:fs'});
    expect(g.reports).toEqual([]);
  });

  it('prints "on" once registered', () => {
    const g = setup(STANDALONE);
    expect(g.status).toBe('on');
    expect(g.logs).toEqual(['[linked] dual-copy guard: on']);
  });

  it('is off with LINKED_DUAL_COPY_GUARD=0 and registers nothing', () => {
    const registerHooks = jest.fn();
    const logs: string[] = [];
    const status = installDualCopyGuard({
      noExternal: STANDALONE,
      env: {LINKED_DUAL_COPY_GUARD: '0'},
      registerHooks,
      log: (l) => logs.push(l),
    });
    expect(status).toBe('off-env');
    expect(registerHooks).not.toHaveBeenCalled();
    expect(logs).toEqual([
      '[linked] dual-copy guard: off (LINKED_DUAL_COPY_GUARD=0)',
    ]);
  });

  it('is off on a Node without module.registerHooks', () => {
    const logs: string[] = [];
    const status = installDualCopyGuard({
      noExternal: STANDALONE,
      env: {},
      registerHooks: undefined,
      nodeVersion: 'v22.10.0',
      log: (l) => logs.push(l),
    });
    expect(status).toBe('off-node');
    expect(logs).toEqual([
      '[linked] dual-copy guard: off (Node v22.10.0 has no module.registerHooks)',
    ]);
  });
});

describe('createPackageFileMatcher', () => {
  it('matches any package under node_modules, scoped or not, with its root', () => {
    const match = createPackageFileMatcher(() => null);
    const file = path.join(APP, 'node_modules/@acme/pets/lib/esm/x.js');
    expect(match(file)).toEqual({
      name: '@acme/pets',
      root: path.join(APP, 'node_modules/@acme/pets'),
      subpath: 'lib/esm/x.js',
    });
    expect(match(path.join(APP, 'node_modules/react/index.js'))).toEqual({
      name: 'react',
      root: path.join(APP, 'node_modules/react'),
      subpath: 'index.js',
    });
  });

  it('finds a package outside node_modules by its nearest named package.json', () => {
    const {read} = fakeReadPackageName();
    const match = createPackageFileMatcher(read);
    expect(match(path.join(LOCAL, 'lib/esm/utils/Server.js'))).toEqual({
      name: '@_linked/server-utils',
      root: LOCAL,
      subpath: 'lib/esm/utils/Server.js',
    });
    expect(match(path.resolve('/cn/src/App.tsx'))).toEqual({
      name: '@semantu/create-now',
      root: path.resolve('/cn'),
      subpath: 'src/App.tsx',
    });
    expect(match(path.resolve('/nowhere/x.js'))).toBeNull();
  });
});
