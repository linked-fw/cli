import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  discoverLocalPackages,
  getLincdPackages,
  planBuildAll,
} from '../../src/lifecycle';

// `build-all` used to discover only packages carrying the linked-package flag,
// inside the `workspaces` globs only, and printed nothing about anything it
// passed over. Measured against Create Now on 2026-09-29 that meant 3 of 6
// tracked workspace members built, `@_linked/maps` (a shipped dependency that
// simply never got the flag) silently dropped, and the 25 localized checkouts
// under `packages-local/` never looked at — all of it behind `exit 0`.
//
// The two properties these tests pin: EVERY local package is found, and every
// one that is not built is NAMED with a reason.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

function makePackage(root: string, json: Record<string, unknown>) {
  writeJson(path.join(root, 'package.json'), json);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

const buildScript = {build: 'echo built'};

describe('build-all package discovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-buildall-')),
    );
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  /**
   * A tree shaped like a real app's: an app root with five workspace members
   * (one flagged app, one with no build script, one dependency that forgot
   * the flag, one the app does not depend on) plus localized checkouts in
   * `packages-local/`, which this app's globs do not cover yet (it has not
   * been set up by `linked localize`).
   */
  function makeTree() {
    writeJson(path.join(tmp, 'package.json'), {
      name: 'the-app',
      private: true,
      linked: {kind: 'app'},
      workspaces: ['packages/*'],
      dependencies: {
        '@w/flagged': '^1.0.0',
        '@w/unflagged': '^1.0.0',
        '@local/dep': '^1.0.0',
      },
    });
    makePackage(path.join(tmp, 'packages', 'flagged'), {
      name: '@w/flagged',
      linked: {kind: 'assets'},
      scripts: buildScript,
    });
    // The `@_linked/maps` case: a real dependency with a working build script
    // that nobody remembered to flag.
    makePackage(path.join(tmp, 'packages', 'unflagged'), {
      name: '@w/unflagged',
      scripts: buildScript,
    });
    makePackage(path.join(tmp, 'packages', 'noscript'), {
      name: '@w/noscript',
      linked: {kind: 'assets'},
    });
    makePackage(path.join(tmp, 'packages', 'inner-app'), {
      name: '@w/inner-app',
      linked: {kind: 'app'},
      scripts: buildScript,
    });
    makePackage(path.join(tmp, 'packages', 'unrelated'), {
      name: '@w/unrelated',
      scripts: buildScript,
    });
    makePackage(path.join(tmp, 'packages-local', 'dep'), {
      name: '@local/dep',
      linked: {kind: 'assets'},
      scripts: buildScript,
    });
    makePackage(path.join(tmp, 'packages-local', 'unrelated'), {
      name: '@local/unrelated',
      linked: {kind: 'assets'},
      scripts: buildScript,
    });
  }

  it('finds packages-local checkouts even when no workspace glob covers them', () => {
    makeTree();
    const names = discoverLocalPackages(tmp)
      .map((p) => p.packageName)
      .sort();
    expect(names).toEqual([
      '@local/dep',
      '@local/unrelated',
      '@w/flagged',
      '@w/inner-app',
      '@w/noscript',
      '@w/unflagged',
      '@w/unrelated',
    ]);
    expect(
      discoverLocalPackages(tmp).find((p) => p.packageName === '@local/dep')
        ?.source,
    ).toBe('local-packages-dir');
  });

  it('finds a checkout once when the `packages-local/*` glob covers it', () => {
    makeTree();
    const pkgPath = path.join(tmp, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.workspaces = ['packages/*', 'packages-local/*'];
    writeJson(pkgPath, pkg);

    const found = discoverLocalPackages(tmp).filter(
      (p) => p.packageName === '@local/dep',
    );
    expect(found).toHaveLength(1);
    expect(found[0].source).toBe('workspace');
    expect(
      planBuildAll(tmp, tmp).skipped.map((s) => s.packageName),
    ).not.toContain('@local/dep');
  });

  it('records the facts callers filter on rather than filtering itself', () => {
    makeTree();
    const byName = new Map(
      discoverLocalPackages(tmp).map((p) => [p.packageName, p]),
    );
    expect(byName.get('@w/unflagged')).toMatchObject({
      isLinkedPackage: false,
      isApp: false,
      hasBuildScript: true,
    });
    expect(byName.get('@w/noscript')).toMatchObject({hasBuildScript: false});
    expect(byName.get('@w/inner-app')).toMatchObject({isApp: true});
  });

  it('getLincdPackages keeps its narrow, workspace-only meaning', () => {
    makeTree();
    // Unchanged contract: flagged packages, from the workspace globs only.
    // The dev resolver and the runtime depend on this set, so widening
    // discovery for build-all must not widen this.
    expect(
      getLincdPackages(tmp)
        .map((p) => p.packageName)
        .sort(),
    ).toEqual(['@w/flagged', '@w/noscript']);
  });

  it('builds an unflagged package that has a build script', () => {
    makeTree();
    const plan = planBuildAll(tmp, tmp);
    // The regression that started this: `@w/unflagged` must not vanish.
    expect([...plan.build.keys()].sort()).toContain('@w/unflagged');
  });

  it('names every package it found but will not build, with a reason', () => {
    makeTree();
    const plan = planBuildAll(tmp, tmp);
    const reasons = Object.fromEntries(
      plan.skipped.map((s) => [s.packageName, s.reason]),
    );
    expect(reasons['@w/noscript']).toMatch(/no `build` script/);
    expect(reasons['@w/inner-app']).toMatch(/linked app/);
    expect(reasons['@w/unrelated']).toMatch(/dependency tree/);

    // Nothing is discovered silently: found == built + skipped, exactly.
    const accounted = [...plan.build.keys(), ...plan.skipped.map((s) => s.packageName)];
    expect(accounted.sort()).toEqual(
      discoverLocalPackages(tmp)
        .map((p) => p.packageName)
        .sort(),
    );
  });

  it('builds everything with a build script when there is no app root', () => {
    makeTree();
    const plan = planBuildAll(tmp, undefined);
    expect([...plan.build.keys()].sort()).toEqual([
      '@local/dep',
      '@local/unrelated',
      '@w/flagged',
      '@w/unflagged',
      '@w/unrelated',
    ]);
  });

  it('builds a localized package the app does not declare yet', () => {
    // A package made with `create-package --location packages-local` is a
    // checkout in `packages-local/`, but cannot be in `dependencies` until it
    // is published. The directory is the record: being there is enough.
    makeTree();
    const plan = planBuildAll(tmp, tmp);
    expect([...plan.build.keys()]).toContain('@local/unrelated');
    expect(plan.skipped.map((s) => s.packageName)).not.toContain(
      '@local/unrelated',
    );
  });
});
