import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  bareName,
  decideCreatePackageTarget,
  ensureRelinkPostinstall,
  ensureWorkspaceGlob,
  findLinkedAppRoot,
  repositoryUrlFor,
} from '../../src/utils/createPackageLocation';

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

describe('ensureRelinkPostinstall', () => {
  it('sets it, appends to an existing hook, and leaves one that relinks alone', () => {
    const none: any = {};
    expect(ensureRelinkPostinstall(none)).toBe(true);
    expect(none.scripts.postinstall).toBe('linked localize --relink');

    const other: any = {scripts: {postinstall: 'patch-package'}};
    expect(ensureRelinkPostinstall(other)).toBe(true);
    expect(other.scripts.postinstall).toBe('patch-package && linked localize --relink');

    const already: any = {scripts: {postinstall: 'linked-localize --relink'}};
    expect(ensureRelinkPostinstall(already)).toBe(false);
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
