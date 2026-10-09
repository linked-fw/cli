import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  bareName,
  decideCreatePackageTarget,
  ensureRelinkHooks,
  ensureRelinkPostinstall,
  ensureWorkspaceGlob,
  findLinkedAppRoot,
  repositoryUrlFor,
} from '../../src/utils/createPackageLocation';
import {ensureRelinkHooksInFile} from '../../src/utils/relinkHooks';

// `create-package` chooses between packages/ (the app's own repository) and
// packages-local/ (a repository of its own, handed to localize). These pin the
// decision table: which flag combinations resolve, which are refused, and that
// a prompt is only ever offered on a terminal with no flags at all.

const APP = '/app';

describe('decideCreatePackageTarget', () => {
  const decide = (options: object, isTTY = false, appRoot: string | null = APP) =>
    decideCreatePackageTarget({appRoot, options, isTTY});

  it('keeps the old behaviour outside an app', () => {
    expect(decide({}, true, null)).toEqual({kind: 'outside'});
  });

  it('refuses location flags outside an app', () => {
    for (const options of [{location: 'packages'}, {remote: 'x'}, {push: true}]) {
      expect(decide(options, true, null).kind).toBe('refuse');
    }
  });

  it('asks only on a terminal, and only when no flag was given', () => {
    expect(decide({}, true)).toEqual({kind: 'ask'});
    const scripted = decide({}, false);
    expect(scripted.kind).toBe('refuse');
    expect((scripted as any).message).toMatch(/--location packages-local/);
  });

  it('takes --location as the complete answer, even on a terminal', () => {
    expect(decide({location: 'packages'}, true)).toEqual({
      kind: 'resolved',
      location: 'packages',
      push: false,
    });
    expect(decide({location: 'packages-local'}, true)).toEqual({
      kind: 'resolved',
      location: 'packages-local',
      push: false,
    });
  });

  it('lets --remote and --push imply packages-local', () => {
    expect(decide({remote: 'git@github.com:o/r.git', push: true})).toEqual({
      kind: 'resolved',
      location: 'packages-local',
      remote: 'git@github.com:o/r.git',
      push: true,
    });
  });

  it('refuses the contradictions', () => {
    expect((decide({push: true}) as any).message).toMatch(/--push needs --remote/);
    expect(
      (decide({location: 'packages', remote: 'https://x/r.git'}) as any).message,
    ).toMatch(/packages-local/);
    expect((decide({location: 'elsewhere'}) as any).message).toMatch(
      /must be one of packages, packages-local/,
    );
  });
});

describe('findLinkedAppRoot', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linked-app-root-')));
  });
  afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}));

  it('finds the nearest linkedApp, with or without workspaces, from a subfolder', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({name: 'app', linkedApp: true}),
    );
    const sub = path.join(tmp, 'packages', 'thing', 'src');
    fs.mkdirSync(sub, {recursive: true});
    fs.writeFileSync(
      path.join(tmp, 'packages', 'thing', 'package.json'),
      JSON.stringify({name: 'thing', linkedPackage: true}),
    );
    expect(findLinkedAppRoot(sub)).toBe(tmp);
  });

  it('returns null when no linkedApp is above', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({name: 'lib'}));
    // the walk continues above tmp, but no ancestor of an os tmpdir is a linked app
    expect(findLinkedAppRoot(tmp)).toBeNull();
  });
});

describe('ensureWorkspaceGlob', () => {
  it('adds packages/* when there are no workspaces, as in the app template', () => {
    const pkg: any = {name: 'app'};
    expect(ensureWorkspaceGlob(pkg)).toEqual({changed: true});
    expect(pkg.workspaces).toEqual(['packages/*']);
  });

  it('leaves a covering glob alone and appends to one that does not cover', () => {
    const covered: any = {workspaces: ['packages/*', 'apps/*']};
    expect(ensureWorkspaceGlob(covered).changed).toBe(false);
    const other: any = {workspaces: ['apps/*']};
    expect(ensureWorkspaceGlob(other).changed).toBe(true);
    expect(other.workspaces).toEqual(['apps/*', 'packages/*']);
    const objectForm: any = {workspaces: {packages: ['apps/*']}};
    expect(ensureWorkspaceGlob(objectForm).changed).toBe(true);
    expect(objectForm.workspaces.packages).toEqual(['apps/*', 'packages/*']);
  });

  it('warns rather than guessing at a shape it does not know', () => {
    const odd: any = {workspaces: {nohoist: ['x']}};
    const r = ensureWorkspaceGlob(odd);
    expect(r.changed).toBe(false);
    expect(r.warning).toMatch(/packages\/\*/);
  });
});

describe('ensureRelinkHooks', () => {
  it('sets both hooks on an app that has neither', () => {
    const none: any = {};
    expect(ensureRelinkHooks(none)).toEqual(['postinstall', 'dependencies']);
    expect(none.scripts).toEqual({
      postinstall: 'linked localize --relink',
      dependencies: 'linked localize --relink',
    });
  });

  it('appends with && to a script that does something else', () => {
    const other: any = {
      scripts: {postinstall: 'patch-package', dependencies: 'echo deps'},
    };
    expect(ensureRelinkHooks(other)).toEqual(['postinstall', 'dependencies']);
    expect(other.scripts.postinstall).toBe(
      'patch-package && linked localize --relink',
    );
    expect(other.scripts.dependencies).toBe(
      'echo deps && linked localize --relink',
    );
  });

  it('does not duplicate, and recognises the retired linked-localize spelling', () => {
    const both: any = {
      scripts: {
        postinstall: 'linked-localize --relink',
        dependencies: 'x && linked localize --relink',
      },
    };
    const before = JSON.stringify(both);
    expect(ensureRelinkHooks(both)).toEqual([]);
    expect(JSON.stringify(both)).toBe(before);

    // the app from before the dependencies hook existed gets only that one
    const old: any = {scripts: {postinstall: 'linked localize --relink'}};
    expect(ensureRelinkHooks(old)).toEqual(['dependencies']);
    expect(old.scripts.postinstall).toBe('linked localize --relink');
    expect(old.scripts.dependencies).toBe('linked localize --relink');
  });

  it('ensureRelinkPostinstall, the older name, sets both and says whether it changed anything', () => {
    const none: any = {};
    expect(ensureRelinkPostinstall(none)).toBe(true);
    expect(none.scripts.dependencies).toBe('linked localize --relink');
    expect(ensureRelinkPostinstall(none)).toBe(false);
  });
});

describe('ensureRelinkHooksInFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-hooks-'));
  });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  it('writes the hooks keeping indentation and the trailing newline', () => {
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify({name: 'app'}, null, 4) + '\n');
    expect(ensureRelinkHooksInFile(file)).toEqual([
      'postinstall',
      'dependencies',
    ]);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^ {4}"scripts"/m);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text).scripts.dependencies).toBe(
      'linked localize --relink',
    );
  });

  it('leaves a missing or unparseable file alone', () => {
    expect(ensureRelinkHooksInFile(path.join(dir, 'nope.json'))).toEqual([]);
    const bad = path.join(dir, 'package.json');
    fs.writeFileSync(bad, '{not json');
    expect(ensureRelinkHooksInFile(bad)).toEqual([]);
    expect(fs.readFileSync(bad, 'utf8')).toBe('{not json');
  });
});

describe('repositoryUrlFor and bareName', () => {
  it('writes repository.url the way npm spells it', () => {
    expect(repositoryUrlFor('https://github.com/o/r.git')).toBe(
      'git+https://github.com/o/r.git',
    );
    expect(repositoryUrlFor('git@github.com:o/r.git')).toBe(
      'git+ssh://git@github.com/o/r.git',
    );
    expect(repositoryUrlFor('git+ssh://git@github.com/o/r.git')).toBe(
      'git+ssh://git@github.com/o/r.git',
    );
  });

  it('drops the scope for packages/', () => {
    expect(bareName('@_linked/foo-bar')).toBe('foo-bar');
    expect(bareName('plain')).toBe('plain');
  });
});
