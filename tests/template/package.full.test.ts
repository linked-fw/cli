// Full test for `create-package`, proving the scaffold is correct the moment it exists.
//
// Scaffolds with the BUILT CLI (lib/esm/launch.js) into a temp directory, which installs
// from the registry and builds, then proves the properties a new package is supposed to
// have and has repeatedly not had:
//
//   - it builds;
//   - the ontology REGISTER sibling is emitted, i.e. something actually calls
//     linkedOntology() (report 058: a self-registering ontology is elided by Rollup as a
//     circular import and the consuming app dies at boot with `_this is not defined`);
//   - the tsconfig compiles the whole src folder, not just the entry graph, so a module
//     nothing imports still emits;
//   - but tests under src do NOT emit;
//   - the tsconfigs carry the fleet-standard emit-neutral shape (rootDir pinned in
//     the base, no downlevelIteration, no moduleResolution node10), and the emit is
//     therefore not nested under an extra src/ level;
//   - it is ESM-only (no tsconfig-cjs.json, no lib/cjs, no `require` export) and its
//     entry and a subpath import under node by name;
//   - no `${...}` template placeholder survives substitution;
//   - the package RESOLVES, under both node10 and bundler — the guard against
//     "fixing" a types field by looking for a file on disk instead of resolving it
//     (create-now backlog-072, retracted).
//
// Needs network and takes a few minutes. Gated by RUN_TEMPLATE_FULL=1 (set by
// `npm run test:template`) so it never runs by accident.
import {execFileSync, execSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

const CLI_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(CLI_ROOT, 'lib', 'esm', 'launch.js');
const TEN_MINUTES = 10 * 60 * 1000;
// `create-package tmplprobe --kind ontology` writes the ontology package `tmplprobe-ont`
// holding the ontology `tmplprobe`.
const NAME = 'tmplprobe';
const PKG = `${NAME}-ont`;
const ONT = NAME;

const describeFull =
  process.env.RUN_TEMPLATE_FULL === '1' ? describe : describe.skip;

const run = (command: string, cwd: string) => {
  try {
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024,
      env: {...process.env, CI: '1', FORCE_COLOR: '0'},
    });
  } catch (err: any) {
    throw new Error(
      `\`${command}\` failed (exit ${err.status}):\n${err.stdout}\n${err.stderr}`,
    );
  }
};

// Every file in the scaffold that is ours (not installed, not generated).
const sourceFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      if (e.name === 'node_modules' || e.name === 'lib' || e.name === '.git')
        continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
};

describeFull('create-package (full)', () => {
  let tmp: string;
  let pkg: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}; run the build first.`);
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-pkg-full-'));
    pkg = path.join(tmp, PKG);
    execFileSync(process.execPath, [CLI, 'create-package', NAME, '--kind', 'ontology'], {
      cwd: tmp,
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024,
    });

    // Two probe modules, added after scaffolding and before the build under test.
    // `orphan` is imported by nothing: it only emits if the tsconfig compiles the
    // whole folder rather than the entry graph.
    fs.writeFileSync(
      path.join(pkg, 'src', 'orphan.ts'),
      'export const orphan = true;\n',
    );
    // ...and this one must NOT emit, however the folder is compiled.
    fs.writeFileSync(
      path.join(pkg, 'src', 'orphan.test.ts'),
      'export const notCompiled = true;\n',
    );
  }, TEN_MINUTES);

  afterAll(() => {
    if (tmp && process.env.KEEP_TEMPLATE_FULL !== '1') {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  });

  test(
    'npm run build succeeds',
    () => {
      run('npm run build', pkg);
      expect(fs.existsSync(path.join(pkg, 'lib', 'esm', 'index.js'))).toBe(true);
    },
    TEN_MINUTES,
  );

  test('the ontology register sibling is emitted and imported', () => {
    const register = path.join(
      pkg,
      'lib',
      'esm',
      'ontologies',
      `${ONT}.register.js`,
    );
    expect([register, fs.existsSync(register)]).toEqual([register, true]);
    // ...and the entry imports it, so linkedOntology() actually runs on boot.
    expect(fs.readFileSync(path.join(pkg, 'lib', 'esm', 'index.js'), 'utf8')).toContain(
      `./ontologies/${ONT}.register.js`,
    );
    expect(fs.readFileSync(register, 'utf8')).toContain('linkedOntology');
    // The template's example-ontology.register.ts must have been renamed away.
    expect(
      fs.existsSync(path.join(pkg, 'src', 'ontologies', 'example-ontology.register.ts')),
    ).toBe(false);
  });

  test('a module nothing imports still emits (whole-folder compile)', () => {
    expect(fs.existsSync(path.join(pkg, 'lib', 'esm', 'orphan.js'))).toBe(true);
  });

  test('a *.test.ts under src does not emit', () => {
    expect(fs.existsSync(path.join(pkg, 'lib', 'esm', 'orphan.test.js'))).toBe(false);
  });

  // The emit-neutral tsconfig shape, shared across the whole @_linked fleet. Asserted
  // here so the template cannot drift back:
  //
  //   - `rootDir: "./src"` in the BASE config, so both derived configs inherit it.
  //     Without it TypeScript infers the root and TS7 emits to lib/esm/src/index.js,
  //     which breaks every path in `exports`. TS7 refuses to infer at all (TS5011).
  //   - no `downlevelIteration` anywhere. It is removed in TS7 (TS5102) and is already
  //     a no-op: every target here is >= es2015.
  //   - no `moduleResolution: "node"`/"node10" — removed in TS7 (TS5108).
  //   - both derived configs `extends` the base, so there is one place to change.
  test('the tsconfigs have the fleet-standard emit-neutral shape', () => {
    const read = (name: string) =>
      ts.parseConfigFileTextToJson(name, fs.readFileSync(path.join(pkg, name), 'utf8'))
        .config as any;

    const base = read('tsconfig.json');
    const esm = read('tsconfig-esm.json');

    expect(base.compilerOptions.rootDir).toBe('./src');

    for (const [name, config] of [
      ['tsconfig.json', base],
      ['tsconfig-esm.json', esm],
    ] as const) {
      expect([name, config.compilerOptions.downlevelIteration]).toEqual([
        name,
        undefined,
      ]);
      expect([name, config.compilerOptions.moduleResolution]).not.toEqual([name, 'node']);
      expect([name, config.compilerOptions.moduleResolution]).not.toEqual([
        name,
        'node10',
      ]);
      // rootDir is inherited, never restated or overridden in a derived config.
      if (name !== 'tsconfig.json') {
        expect([name, config.extends]).toEqual([name, './tsconfig.json']);
        expect([name, config.compilerOptions.rootDir]).toEqual([name, undefined]);
      }
    }

    // The emit target is what the `exports` map and `typesVersions` point at.
    expect(esm.compilerOptions.outDir).toBe('lib/esm');
  });

  // The direct consequence of rootDir: the entry lands at lib/esm/index.js, NOT at
  // lib/esm/src/index.js. This is what actually breaks when rootDir is absent.
  test('the emit is not nested under an extra src/ level', () => {
    expect(fs.existsSync(path.join(pkg, 'lib', 'esm', 'src'))).toBe(false);
  });

  // ESM-only: a CJS build of anything importing @_linked/core cannot load (core is
  // ESM-only, so `require` of it fails with ERR_PACKAGE_PATH_NOT_EXPORTED). The
  // scaffold must not produce one, nor carry the config that would.
  test('the package is ESM-only: no CJS config, build or export', () => {
    expect(fs.existsSync(path.join(pkg, 'tsconfig-cjs.json'))).toBe(false);
    expect(fs.existsSync(path.join(pkg, 'lib', 'cjs'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('lib/esm/index.js');
    expect(JSON.stringify(manifest.exports)).not.toContain('require');
    expect(JSON.stringify(manifest.exports)).not.toContain('development');
    expect(manifest.devDependencies['tsconfig-to-dual-package']).toBeUndefined();
  });

  // The published entry and a subpath load under Node's own ESM resolver, through the
  // exports map (a symlink into node_modules, so the package resolves by name).
  test('the built package imports under node by name and by subpath', () => {
    const consumer = path.join(tmp, 'node-consumer');
    fs.mkdirSync(path.join(consumer, 'node_modules'), {recursive: true});
    const link = path.join(consumer, 'node_modules', PKG);
    if (!fs.existsSync(link)) fs.symlinkSync(pkg, link, 'dir');
    const out = run(
      `node --input-type=module -e "const a = await import('${PKG}'); const b = await import('${PKG}/package'); console.log(typeof a, b.packageName)"`,
      consumer,
    );
    expect(out.trim()).toBe(`object ${PKG}`);
  });

  test('a new package is gitignored from minute one', () => {
    const gitignore = path.join(pkg, '.gitignore');
    expect([gitignore, fs.existsSync(gitignore)]).toEqual([gitignore, true]);
    const body = fs.readFileSync(gitignore, 'utf8');
    for (const line of ['lib', 'node_modules', '*.tsbuildinfo']) {
      expect(body).toContain(line);
    }
    expect(fs.existsSync(path.join(pkg, 'gitignore.template'))).toBe(false);
  });

  test('no file in the scaffold contains an unsubstituted ${ placeholder', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(pkg)) {
      let body: string;
      try {
        body = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // Template placeholders are `${lower_snake_name}`; a real JS template literal
      // interpolates an expression, so restrict to the placeholder shape.
      const hits = body.match(/\$\{[a-z][a-z0-9_]*\}/g);
      if (hits) offenders.push(`${path.relative(pkg, file)}: ${hits.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  // The guard against create-now backlog-072: whether the package's TYPES resolve is a
  // question for ts.resolveModuleName, under every resolution mode a consumer may use —
  // never for `ls`.
  //
  // The template declares `"types": "index.d.ts"` — a path that does not exist on disk —
  // and relies on `typesVersions: {"*":{"*":["lib/esm/*"]}}`, which TypeScript applies to
  // the `types` field too, to rewrite it to `lib/esm/index.d.ts`. That looks like a bug and
  // is not; writing the literal path instead applies the mapping twice and breaks node10.
  // This assertion is what makes the difference measurable, so nobody has to trust the
  // comment.
  test('the scaffolded package resolves under both node10 and bundler', () => {
    // Resolve as a consumer would: a sibling directory with the package linked in.
    const consumer = path.join(tmp, 'consumer');
    fs.mkdirSync(path.join(consumer, 'node_modules'), {recursive: true});
    const link = path.join(consumer, 'node_modules', PKG);
    if (!fs.existsSync(link)) fs.symlinkSync(pkg, link, 'dir');

    const results: Record<string, string> = {};
    for (const [name, kind] of [
      ['node10', ts.ModuleResolutionKind.Node10],
      ['bundler', ts.ModuleResolutionKind.Bundler],
    ] as const) {
      const r = ts.resolveModuleName(
        PKG,
        path.join(consumer, 'probe.ts'),
        {
          moduleResolution: kind,
          module:
            kind === ts.ModuleResolutionKind.Bundler
              ? ts.ModuleKind.ESNext
              : ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ESNext,
        },
        ts.sys,
      );
      results[name] = r.resolvedModule?.resolvedFileName ?? 'FAILED';
    }
    // realpath: on macOS the temp dir is a symlink (/var -> /private/var) and TypeScript
    // returns the resolved path for some modes and not others.
    const expected = fs.realpathSync(path.join(pkg, 'lib', 'esm', 'index.d.ts'));
    expect({
      node10: results.node10 === 'FAILED' ? 'FAILED' : fs.realpathSync(results.node10),
      bundler: results.bundler === 'FAILED' ? 'FAILED' : fs.realpathSync(results.bundler),
    }).toEqual({node10: expected, bundler: expected});
  });
});
