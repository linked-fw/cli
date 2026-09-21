import {
  explainUnresolvedWorkspaceImport,
  findInlinedWorkspaceImports,
  resolveBackendEntries,
  workspacePackagesToExternalize,
} from '../../src/app-release/build-backend';

describe('resolveBackendEntries', () => {
  const present = (paths: string[]) => (p: string) =>
    paths.some((candidate) => p.endsWith(candidate));

  test('names the three entries a compiled app is started from', () => {
    const entries = resolveBackendEntries(
      '/app',
      present(['src/backend.ts', 'src/App.tsx', 'src/routes.tsx'])
    );

    expect(Object.keys(entries).sort()).toEqual(['App', 'backend', 'routes']);
  });

  test('accepts either extension for each entry', () => {
    const entries = resolveBackendEntries(
      '/app',
      present(['src/backend.ts', 'src/App.ts', 'src/routes.ts'])
    );

    expect(entries.App).toContain('App.ts');
    expect(entries.routes).toContain('routes.ts');
  });

  test('omits an entry the app does not have', () => {
    const entries = resolveBackendEntries('/app', present(['src/backend.ts']));

    expect(Object.keys(entries)).toEqual(['backend']);
  });
});

describe('workspacePackagesToExternalize', () => {
  test('lists every discovered workspace, deduplicated and sorted', async () => {
    const names = await workspacePackagesToExternalize('/app', async () => [
      {name: '@_linked/server'},
      {name: '@_linked/core'},
      {name: 'create-now-js'},
      {name: '@_linked/core'},
    ]);

    expect(names).toEqual([
      '@_linked/core',
      '@_linked/server',
      'create-now-js',
    ]);
  });

  test('an app with no workspaces externalizes nothing extra', async () => {
    expect(await workspacePackagesToExternalize('/app', async () => [])).toEqual(
      []
    );
  });
});

describe('findInlinedWorkspaceImports', () => {
  // The whole point of externalizing: a relative import into packages/ is a
  // second copy of that package, and a second @_linked/core splits
  // LinkedStorage's routing state from the one the storage config configures.
  test('spots a workspace package compiled into the output', () => {
    const source = [
      'import {LinkedStorage} from "./packages/core/lib/esm/utils/LinkedStorage.js";',
      'import {Project} from "./packages/create-now-js/src/shapes/Project.js";',
    ].join('\n');

    expect(findInlinedWorkspaceImports(source)).toEqual([
      './packages/core/lib/esm/utils/LinkedStorage.js',
      './packages/create-now-js/src/shapes/Project.js',
    ]);
  });

  test('a correctly externalized backend reports nothing', () => {
    const source = [
      'import {LinkedStorage} from "@_linked/core/utils/LinkedStorage";',
      'import {runWithRequestContext} from "./data/AppDataRouter.js";',
      "import express from 'express';",
    ].join('\n');

    expect(findInlinedWorkspaceImports(source)).toEqual([]);
  });

  test('does not confuse an app directory that happens to be named packages', () => {
    // `@_linked/foo/packages/…` is a bare specifier, not a relative one.
    const source = 'import x from "@_linked/foo/packages/bar.js";';

    expect(findInlinedWorkspaceImports(source)).toEqual([]);
  });
});

describe('explainUnresolvedWorkspaceImport', () => {
  const externals = ['@_linked/core', 'create-now-js'];

  test('points a failed workspace import at that package’s stale lib', () => {
    const explained = explainUnresolvedWorkspaceImport(
      '[vite]: Rollup failed to resolve import "create-now-js/orchestrators/Refresh" from "/app/src/backend.ts".',
      externals
    );

    expect(explained).toContain('"create-now-js" is a workspace package');
    expect(explained).toContain("that package's lib/ is stale");
  });

  test('leaves an unrelated unresolved import alone', () => {
    expect(
      explainUnresolvedWorkspaceImport(
        'Rollup failed to resolve import "some-npm-package" from "/app/src/backend.ts".',
        externals
      )
    ).toBeNull();
  });

  test('leaves an error that is not about resolution alone', () => {
    expect(
      explainUnresolvedWorkspaceImport('Unexpected token', externals)
    ).toBeNull();
  });
});
