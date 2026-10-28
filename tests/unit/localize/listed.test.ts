/**
 * `linked localize --listed` against real git: an app clone whose committed package.json lists
 * an ontology and an asset package (the asset package lists the ontology package too), with
 * `file://` remotes. npm is stubbed (the install itself is real-localize.test.ts's subject); git
 * is real.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {localizeListed} from '../../../src/localize/localize.js';
import {makeRun, type Deps, type RunOptions} from '../../../src/localize/run.js';
import {commitOn, git, makeRemotes, tmp, type Remotes} from '../checkout/helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true});
});

interface Recorded {
  deps: Deps;
  npm: {args: string[]; opts?: RunOptions}[];
  out: string[];
}

function depsFor(appRoot: string): Recorded {
  const real = makeRun(appRoot);
  const npm: Recorded['npm'] = [];
  const out: string[] = [];
  return {
    npm,
    out,
    deps: {
      appRoot,
      run: (cmd, args, opts) => {
        if (cmd === 'npm') {
          npm.push({args, opts});
          return {status: 0, stdout: '', stderr: ''};
        }
        return real(cmd, args, opts);
      },
      log: (m) => out.push(m),
      warn: (m) => out.push(m),
      error: (m) => out.push(m),
    },
  };
}

function cloneApp(r: Remotes, branch: string): string {
  const parent = tmp('listed-app-');
  dirs.push(parent);
  const app = path.join(parent, 'app');
  git(parent, 'clone', '-q', r.url(r.app), app);
  git(app, 'config', 'core.hooksPath', '/dev/null');
  git(app, 'switch', '-q', '-c', branch);
  return app;
}

describe('linked localize --listed', () => {
  let r: Remotes;
  beforeEach(() => {
    r = makeRemotes();
    dirs.push(r.base);
  });

  test('clones the list transitively, on the app branch where the repo has it, in one install', () => {
    const app = cloneApp(r, 'change-1');
    const {deps, npm, out} = depsFor(app);
    const prev = process.env.LINKED_GIT_TOKEN;
    process.env.LINKED_GIT_TOKEN = 'ghs_listedTestToken';
    let code: number;
    try {
      code = localizeListed({build: ''}, deps);
    } finally {
      if (prev === undefined) delete process.env.LINKED_GIT_TOKEN;
      else process.env.LINKED_GIT_TOKEN = prev;
    }
    assert.equal(code, 0, out.join('\n'));
    const ont = path.join(app, 'packages-local', 'acme-ont');
    const assets = path.join(app, 'packages-local', 'acme-assets');
    assert.equal(git(ont, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(assets, 'rev-parse', '--abbrev-ref', 'HEAD'), 'change-1');
    assert.ok(out.some((m) => /acme-ont: its repo has no branch change-1, so it stays on main/.test(m)), out.join('\n'));
    // one install, at the app root, without the token
    const installs = npm.filter((c) => c.args[0] === 'install' && !c.args.includes('--package-lock-only'));
    assert.equal(installs.length, 1);
    assert.equal(installs[0].opts?.env?.LINKED_GIT_TOKEN, undefined);
    assert.equal(git(ont, 'config', '--get', 'remote.origin.url'), r.url(r.ont));
  });

  test('a listed package already in packages-local/ is used as it is, and its list followed', () => {
    const app = cloneApp(r, 'change-1');
    fs.mkdirSync(path.join(app, 'packages-local'), {recursive: true});
    git(app, 'clone', '-q', r.url(r.assets), path.join(app, 'packages-local', 'acme-assets'));
    // The app lists only the asset package now; the ontology package comes from its list.
    const pkgFile = path.join(app, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    delete pkg.linked.unpublishedPackages['acme-ont'];
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    const {deps, out} = depsFor(app);
    assert.equal(localizeListed({build: ''}, deps), 0, out.join('\n'));
    assert.ok(out.some((m) => /acme-assets: in packages-local\/acme-assets already/.test(m)));
    assert.ok(fs.existsSync(path.join(app, 'packages-local', 'acme-ont', 'ont.ttl')));
  });

  test('two repos for one name refuse before the install', () => {
    commitOn(
      r.base,
      r.assets,
      'main',
      'package.json',
      JSON.stringify({name: 'acme-assets', linked: {kind: 'assets', unpublishedPackages: {'acme-ont': {repo: 'https://github.com/fork/acme-ont.git'}}}}),
    );
    const app = cloneApp(r, 'other');
    const {deps, npm, out} = depsFor(app);
    assert.equal(localizeListed({build: ''}, deps), 6);
    assert.ok(out.some((m) => /acme-ont is listed with two repos/.test(m)), out.join('\n'));
    assert.equal(npm.filter((c) => c.args[0] === 'install' && !c.args.includes('--package-lock-only')).length, 0);
  });

  test('a repo that is not the package it is listed as is removed and refused', () => {
    const app = cloneApp(r, 'main2');
    const pkgFile = path.join(app, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.linked.unpublishedPackages = {'acme-other': {repo: r.url(r.ont)}};
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    const {deps, out} = depsFor(app);
    assert.equal(localizeListed({build: ''}, deps), 6);
    assert.ok(out.some((m) => /declares itself as "acme-ont", not "acme-other"/.test(m)), out.join('\n'));
    assert.ok(!fs.existsSync(path.join(app, 'packages-local', 'acme-other')));
  });

  test('no list: nothing to do', () => {
    const app = cloneApp(r, 'x');
    const pkgFile = path.join(app, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    delete pkg.linked.unpublishedPackages;
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    const {deps, out} = depsFor(app);
    assert.equal(localizeListed({}, deps), 0);
    assert.ok(out.some((m) => /lists no linked.unpublishedPackages/.test(m)));
  });
});
