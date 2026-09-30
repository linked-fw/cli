import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertNoInlinedWorkspaces,
  explainUnresolvedWorkspaceImport,
  findImportSpecifiers,
  packageRootsForApp,
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

describe('findImportSpecifiers', () => {
  test('reads static, side-effect, dynamic and require imports', () => {
    const source = [
      'import {a} from "./a.js";',
      'import "../b.js";',
      'export * from "./c.js";',
      'const Page = () => import("./d.js");',
      "const e = require('./e.js');",
      "import express from 'express';",
    ].join('\n');

    expect(findImportSpecifiers(source)).toEqual([
      '../b.js',
      './a.js',
      './c.js',
      './d.js',
      './e.js',
      'express',
    ]);
  });
});

describe('assertNoInlinedWorkspaces', () => {
  // A fixture app on disk: src/, a compiled lib/ with sourcemaps, and package
  // source it may or may not have compiled in.
  let app: string;
  const write = (rel: string, content: string) => {
    const full = path.join(app, rel);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, content);
  };
  // Emit lib/<rel>.js compiled from <sourceRel>, with the sourcemap Rollup writes.
  const emit = (rel: string, sourceRel: string, code: string) => {
    write(`lib/${rel}.js`, code);
    const mapFile = path.join(app, 'lib', `${rel}.js.map`);
    write(
      `lib/${rel}.js.map`,
      JSON.stringify({
        version: 3,
        sources: [path.relative(path.dirname(mapFile), path.join(app, sourceRel))],
        mappings: '',
      })
    );
  };
  const documentsRoot = () => [
    {root: fs.realpathSync(path.join(app, 'packages/documents')), name: '@_linked/documents'},
  ];
  const DEEP = 'features/document-studio/components/organisms/PageView';

  beforeEach(() => {
    app = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    write(`src/${DEEP}.tsx`, '');
    write('src/backend.ts', '');
    write('packages/documents/package.json', '{"name":"@_linked/documents"}');
    write('packages/documents/src/conformance/viewmodels.ts', '');
    write('packages/documents/src/conformance/index.ts', '');
    emit('backend', 'src/backend.ts', 'import express from "express";');
  });
  afterEach(() => fs.rmSync(app, {recursive: true, force: true}));

  test('fails on a workspace package compiled in deep inside a feature folder', async () => {
    // What a resolve.alias to the package's src produced in CN: the entries are
    // clean, and the copy is reached from a component four folders down.
    emit(
      DEEP,
      `src/${DEEP}.tsx`,
      'import {pageOutline} from "../../../../packages/documents/src/conformance/viewmodels.js";'
    );
    emit(
      'packages/documents/src/conformance/viewmodels',
      'packages/documents/src/conformance/viewmodels.ts',
      'export const pageOutline = 1;'
    );

    const failure = assertNoInlinedWorkspaces(app, documentsRoot());
    await expect(failure).rejects.toThrow(`lib/${DEEP}.js imports`);
    await expect(failure).rejects.toThrow(
      '"../../../../packages/documents/src/conformance/viewmodels.js"'
    );
    await expect(failure).rejects.toThrow('(@_linked/documents)');
    await expect(failure).rejects.toThrow('public export');
    await expect(failure).rejects.toThrow('lib/packages/ exists');
  });

  test('traces the copy by its source, whatever its directory in lib/ is called', async () => {
    emit(DEEP, `src/${DEEP}.tsx`, 'import "../../../../_ext/docs/viewmodels.js";');
    emit(
      '_ext/docs/viewmodels',
      'packages/documents/src/conformance/viewmodels.ts',
      'export const pageOutline = 1;'
    );

    await expect(assertNoInlinedWorkspaces(app, documentsRoot())).rejects.toThrow(
      `lib/${DEEP}.js imports "../../../../_ext/docs/viewmodels.js"`
    );
  });

  test('catches a localized checkout reached through a node_modules symlink', async () => {
    // node_modules/@_linked/core -> packages-local/core: its real path has no
    // node_modules in it, which is what a path-matching guard missed.
    write('packages-local/core/src/utils/LinkedStorage.ts', '');
    fs.mkdirSync(path.join(app, 'node_modules/@_linked'), {recursive: true});
    fs.symlinkSync(
      path.join(app, 'packages-local/core'),
      path.join(app, 'node_modules/@_linked/core')
    );
    emit('App', 'src/backend.ts', 'import {LinkedStorage} from "./vendor/LinkedStorage.js";');
    emit(
      'vendor/LinkedStorage',
      'node_modules/@_linked/core/src/utils/LinkedStorage.ts',
      'export class LinkedStorage {}'
    );

    const roots = await packageRootsForApp(app, async () => []);
    await expect(assertNoInlinedWorkspaces(app, roots)).rejects.toThrow(
      /lib\/App\.js imports "\.\/vendor\/LinkedStorage\.js"[\s\S]*\(@_linked\/core\)/
    );
  });

  test('fails on an import that leaves lib/ for a package outright', async () => {
    write('node_modules/@_linked/server-utils/lib/esm/BackendProvider.js', '');
    emit(
      'backend',
      'src/backend.ts',
      'import {BackendProvider} from "../node_modules/@_linked/server-utils/lib/esm/BackendProvider.js";'
    );

    const roots = await packageRootsForApp(app, async () => []);
    await expect(assertNoInlinedWorkspaces(app, roots)).rejects.toThrow(
      '(@_linked/server-utils)'
    );
  });

  test('passes a backend that imports packages through their exports', async () => {
    emit(
      DEEP,
      `src/${DEEP}.tsx`,
      [
        'import {pageOutline} from "@_linked/documents/conformance";',
        'import {Row} from "./FieldFirstTable.js";',
        'const lazy = () => import("../molecules/PageRail.js");',
      ].join('\n')
    );
    write('src/features/document-studio/components/organisms/FieldFirstTable.tsx', '');
    emit(
      'features/document-studio/components/organisms/FieldFirstTable',
      'src/features/document-studio/components/organisms/FieldFirstTable.tsx',
      ''
    );

    await expect(assertNoInlinedWorkspaces(app, documentsRoot())).resolves.toBeUndefined();
  });

  test('does not flag the app when it is discovered as a workspace itself', async () => {
    write('package.json', '{"name":"my-app"}');
    emit(DEEP, `src/${DEEP}.tsx`, 'import "../../../../backend.js";');
    // No sourcemap, so this file is scanned whatever it is taken to be, and it
    // reaches both the app's own module and a file of the app outside lib/.
    write('lib/routes.js', 'import "./backend.js";\nimport pkg from "../package.json";');

    const roots = await packageRootsForApp(app, async () => [
      {name: 'my-app', srcDir: path.join(app, 'src')},
    ]);
    await expect(assertNoInlinedWorkspaces(app, roots)).resolves.toBeUndefined();
  });

  test('fails on lib/packages/ even without a sourcemap to trace', async () => {
    write('lib/packages/documents/src/index.js', '');

    await expect(assertNoInlinedWorkspaces(app, [])).rejects.toThrow(
      'lib/packages/ exists'
    );
  });

  test('allows lib/packages/ when the app has its own src/packages/', async () => {
    write('src/packages/list.ts', '');
    emit('packages/list', 'src/packages/list.ts', '');

    await expect(assertNoInlinedWorkspaces(app, documentsRoot())).resolves.toBeUndefined();
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
