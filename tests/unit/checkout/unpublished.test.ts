/**
 * The pure rules behind `linked checkout` and `linked localize --listed`: the list reader, the
 * transitive walk, the branch rule, branch directories, and the release order's list edges.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {dependencyOrder} from '../../../src/commands/release.js';
import {unpublishedPackages} from '../../../src/installed-packages.js';
import {
  appBranch,
  branchDir,
  packageBranch,
  walkUnpublished,
  type ListedPackage,
} from '../../../src/integration/unpublished.js';
import {LocalizeError} from '../../../src/localize/errors.js';

const list = (name: string, entries: Record<string, string>) => ({
  name,
  linked: {
    kind: 'app',
    unpublishedPackages: Object.fromEntries(Object.entries(entries).map(([n, repo]) => [n, {repo}])),
  },
});

const refusal = (fn: () => unknown): LocalizeError => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LocalizeError, String(e));
    return e;
  }
  throw new Error('expected a refusal');
};

describe('unpublishedPackages', () => {
  test('reads the entries, normalized', () => {
    assert.deepEqual(
      unpublishedPackages(
        list('app', {
          'acme-ont': 'git+https://github.com/org/acme-ont.git',
          'acme-assets': 'file:///srv/repos/acme-assets.git',
        }),
      ),
      [
        {name: 'acme-ont', repo: 'https://github.com/org/acme-ont.git'},
        {name: 'acme-assets', repo: 'file:///srv/repos/acme-assets.git'},
      ],
    );
  });

  test('absent list, absent linked, non-objects: none', () => {
    assert.deepEqual(unpublishedPackages({name: 'x'}), []);
    assert.deepEqual(unpublishedPackages({linked: {kind: 'app'}}), []);
    assert.deepEqual(unpublishedPackages(null), []);
    assert.deepEqual(unpublishedPackages('nope'), []);
  });

  test('a list that is not an object is an error', () => {
    for (const bad of [[], 'x', 1, null]) {
      const e = refusal(() => unpublishedPackages({name: 'app', linked: {unpublishedPackages: bad}}));
      assert.equal(e.code, 6);
      assert.match(e.message, /linked\.unpublishedPackages of app/);
    }
  });

  test('an entry without a repo, or with one that is not https/file, is an error', () => {
    assert.match(
      refusal(() => unpublishedPackages({linked: {unpublishedPackages: {a: {}}}})).message,
      /"a" needs \{"repo"/,
    );
    assert.match(
      refusal(() => unpublishedPackages({linked: {unpublishedPackages: {a: 'https://x/y'}}})).message,
      /"a" needs/,
    );
    assert.match(
      refusal(() => unpublishedPackages(list('app', {a: 'git@github.com:org/a.git'}))).message,
      /not an https:\/\//,
    );
    assert.match(
      refusal(() => unpublishedPackages(list('app', {a: 'http://example.com/a.git'}))).message,
      /not an https:\/\//,
    );
  });

  test('userinfo is stripped, with a warning', () => {
    const warnings: string[] = [];
    const got = unpublishedPackages(
      list('app', {a: 'https://x-access-token:ghs_secret@github.com/org/a.git'}),
      (m) => warnings.push(m),
    );
    assert.deepEqual(got, [{name: 'a', repo: 'https://github.com/org/a.git'}]);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /ghs_secret/);
  });
});

describe('the branch key', () => {
  const keyed = (branch: unknown) => ({
    name: 'app',
    linked: {unpublishedPackages: {ont: {repo: 'https://github.com/org/ont.git', branch}}},
  });

  test('a valid branch is kept', () => {
    assert.deepEqual(unpublishedPackages(keyed('rene/topic')), [
      {name: 'ont', repo: 'https://github.com/org/ont.git', branch: 'rene/topic'},
    ]);
  });

  test('main, HEAD, empty, invalid names and non-strings refuse, naming the entry', () => {
    for (const bad of ['main', 'HEAD', '', 'a..b', '-x', 'a b', 'x.lock', 3, null, {}]) {
      const e = refusal(() => unpublishedPackages(keyed(bad)));
      assert.equal(e.code, 6, String(bad));
      assert.match(e.message, /linked\.unpublishedPackages of app: "ont" has branch/);
    }
  });
});

describe('walkUnpublished', () => {
  const R = (n: string) => `https://github.com/org/${n}.git`;
  const withKeys = (name: string, entries: Record<string, {repo: string; branch?: string}>) => ({
    name,
    linked: {kind: 'app', unpublishedPackages: entries},
  });

  test("keeps the root's keys, drops a package's with one warning each", () => {
    const warnings: string[] = [];
    const got = walkUnpublished(
      withKeys('app', {a: {repo: R('a'), branch: 'rene/topic'}, b: {repo: R('b')}}),
      (e) => (e.name === 'b' ? withKeys('b', {c: {repo: R('c'), branch: 'other'}}) : null),
      (m) => warnings.push(m),
    );
    assert.deepEqual(
      got.map((p) => [p.name, p.branch]),
      [
        ['a', 'rene/topic'],
        ['b', undefined],
        ['c', undefined],
      ],
    );
    assert.ok(!('branch' in got[2]));
    assert.deepEqual(warnings, ["b's list names branch other for c; ignored, the app's list decides."]);
  });

  test('a name reached twice with differing keys is no conflict; the root key stays', () => {
    const warnings: string[] = [];
    const got = walkUnpublished(
      withKeys('app', {a: {repo: R('a'), branch: 'x'}, b: {repo: R('b')}}),
      (e) =>
        e.name === 'b'
          ? withKeys('b', {a: {repo: R('a'), branch: 'y'}, c: {repo: R('c'), branch: 'z'}})
          : e.name === 'c'
            ? withKeys('c', {d: {repo: R('d'), branch: 'w'}, a: {repo: R('a')}})
            : null,
      (m) => warnings.push(m),
    );
    assert.deepEqual(
      got.map((p) => [p.name, p.branch, p.requiredBy]),
      [
        ['a', 'x', ['app', 'b', 'c']],
        ['b', undefined, ['app']],
        ['c', undefined, ['b']],
        ['d', undefined, ['c']],
      ],
    );
    assert.equal(warnings.length, 3);
  });

  test('breadth first, each package once, with every requirer', () => {
    const packages: Record<string, unknown> = {
      'p-assets': list('p-assets', {'p-ont': R('p-ont')}),
      'p-ont': list('p-ont', {}),
    };
    const loaded: string[] = [];
    const got = walkUnpublished(list('app', {'p-ont': R('p-ont'), 'p-assets': R('p-assets')}), (e) => {
      loaded.push(e.name);
      return packages[e.name];
    });
    assert.deepEqual(loaded, ['p-ont', 'p-assets']);
    assert.deepEqual(
      got.map((p: ListedPackage) => [p.name, p.requiredBy]),
      [
        ['p-ont', ['app', 'p-assets']],
        ['p-assets', ['app']],
      ],
    );
  });

  test('transitive: a package only a package lists is reached', () => {
    const got = walkUnpublished(list('app', {b: R('b')}), (e) =>
      e.name === 'b' ? list('b', {c: R('c')}) : list(e.name, {}),
    );
    assert.deepEqual(got.map((p) => p.name), ['b', 'c']);
    assert.deepEqual(got[1].requiredBy, ['b']);
  });

  test('the same name with two repos refuses, naming both requirers, before loading the second', () => {
    const loaded: string[] = [];
    const e = refusal(() =>
      walkUnpublished(list('app', {a: R('a'), b: R('b')}), (entry) => {
        loaded.push(entry.name);
        return entry.name === 'b' ? list('b', {a: 'https://github.com/fork/a.git'}) : null;
      }),
    );
    assert.equal(e.code, 6);
    assert.match(e.message, /a is listed with two repos/);
    assert.match(e.message, /by app/);
    assert.match(e.message, /by b/);
    assert.deepEqual(loaded, ['a', 'b']);
  });

  test('a cycle ends', () => {
    const got = walkUnpublished(list('app', {a: R('a')}), (e) =>
      e.name === 'a' ? list('a', {b: R('b')}) : list('b', {a: R('a')}),
    );
    assert.deepEqual(got.map((p) => [p.name, p.requiredBy]), [
      ['a', ['app', 'b']],
      ['b', ['a']],
    ]);
  });
});

describe('branch rule', () => {
  test('a package: its branch when the repo has it, else the default (fell back)', () => {
    assert.deepEqual(packageBranch('change-1', true, 'main'), {on: 'branch', branch: 'change-1', fellBack: false});
    assert.deepEqual(packageBranch('change-1', false, 'main'), {on: 'default', branch: 'main', fellBack: true});
    assert.deepEqual(packageBranch(null, true, 'main'), {on: 'default', branch: 'main', fellBack: true});
  });

  test('the app: on the branch when the remote has it, else created from --from', () => {
    assert.deepEqual(appBranch(true, 'origin/HEAD'), {create: false});
    assert.deepEqual(appBranch(false, 'origin/release'), {create: true, from: 'origin/release'});
  });

  test('branchDir', () => {
    assert.equal(branchDir('feat/x'), 'feat__x');
    assert.equal(branchDir('a/b/c'), 'a__b__c');
    assert.equal(branchDir('change-1'), 'change-1');
  });
});

describe('dependencyOrder with linked.unpublishedPackages edges', () => {
  test('an asset package that lists the ontology package comes after it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'order-'));
    try {
      const repo = (rel: string, pkg: object) => {
        const dir = path.join(tmp, rel);
        fs.mkdirSync(dir, {recursive: true});
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
        return {rel, dir, packageName: (pkg as {name: string}).name};
      };
      // "a-assets" sorts before "z-ont": without the edge it would come first.
      const assets = repo('packages-local/a-assets', list('a-assets', {'z-ont': 'https://github.com/o/z.git'}));
      const ont = repo('packages-local/z-ont', {name: 'z-ont'});
      const app = repo('.', list('app', {'a-assets': 'x', 'z-ont': 'y'}));
      assert.deepEqual(dependencyOrder([app, assets, ont]).map((r) => r.rel), [
        'packages-local/z-ont',
        'packages-local/a-assets',
        '.',
      ]);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  });
});
