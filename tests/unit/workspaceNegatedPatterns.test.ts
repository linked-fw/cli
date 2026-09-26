import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseWorkspacePatterns,
  isWorkspacePathNegated,
} from '../../src/workspace-globs';
import {discoverWorkspaces} from '../../src/vite-config';
import {getLincdPackages} from '../../src/lifecycle';
import {discoverWorkspacePackages} from '../../src/commands/start';

// npm honours NEGATED `workspaces` entries ("!packages/core"); every walker in
// this CLI must too. CN's npm migration narrows its globs to that form so the
// gitignored mrgit checkouts under packages/ stop counting as members — and a
// walker that ignores the `!` resolves @_linked/primitives to one of those
// checkouts, whose deps npm never installed, so dev does not boot.
//
// The expectations below are not invented: each row was run through npm's own
// @npmcli/map-workspaces and matches what it returns. See the table in
// src/workspace-globs.ts.

function writeJson(file: string, json: unknown) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
}

/** A source-shipping package: package.json + a src/ dir (what the walkers key on). */
function makePackage(root: string, json: Record<string, unknown>) {
  writeJson(path.join(root, 'package.json'), json);
  fs.mkdirSync(path.join(root, 'src'), {recursive: true});
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};');
}

describe('workspaces negated patterns', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'linked-wsneg-')),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  // --- the shared matcher, against npm's measured behaviour -----------------

  describe('parseWorkspacePatterns', () => {
    const split = (ws: unknown) => {
      const {patterns, negatedPatterns} = parseWorkspacePatterns(ws);
      return {patterns, negatedPatterns};
    };

    it('separates negated from positive entries', () => {
      expect(split(['packages/*', '!packages/core'])).toEqual({
        patterns: ['packages/*'],
        negatedPatterns: ['packages/core'],
      });
    });

    it('is insensitive to a negation appearing before the positive it narrows', () => {
      expect(split(['!packages/core', 'packages/*'])).toEqual({
        patterns: ['packages/*'],
        negatedPatterns: ['packages/core'],
      });
    });

    it('lets a later exact pattern re-include what a negation excluded', () => {
      // npm: ['packages/*','!packages/b','packages/b'] -> a, b, c
      expect(split(['packages/*', '!packages/b', 'packages/b'])).toEqual({
        patterns: ['packages/*', 'packages/b'],
        negatedPatterns: [],
      });
    });

    it('does not let a later WIDER pattern cancel a negation', () => {
      // npm: ['packages/*','!packages/b','packages/*'] -> a, c. Cancelling needs
      // the pattern STRING to match the negation glob; `packages/*` does not.
      expect(split(['packages/*', '!packages/b', 'packages/*'])).toEqual({
        patterns: ['packages/*', 'packages/*'],
        negatedPatterns: ['packages/b'],
      });
    });

    it('treats an even number of `!` as positive', () => {
      // npm: ['packages/*','!!packages/b'] -> a, b, c
      expect(split(['packages/*', '!!packages/b'])).toEqual({
        patterns: ['packages/*', 'packages/b'],
        negatedPatterns: [],
      });
    });

    it('strips a leading ./ or /', () => {
      expect(split(['./packages/*', '!/packages/b'])).toEqual({
        patterns: ['packages/*'],
        negatedPatterns: ['packages/b'],
      });
    });

    it('prunes a positive pattern a negation covers outright', () => {
      // npm: ['packages/*','!packages/*'] -> (none)
      expect(split(['packages/*', '!packages/*'])).toEqual({
        patterns: [],
        negatedPatterns: ['packages/*'],
      });
    });

    it('accepts the legacy {packages: [...]} form and ignores non-strings', () => {
      expect(split({packages: ['packages/*', '!packages/b', 42]})).toEqual({
        patterns: ['packages/*'],
        negatedPatterns: ['packages/b'],
      });
    });

    it('returns empty lists for a missing or malformed field', () => {
      expect(split(undefined)).toEqual({patterns: [], negatedPatterns: []});
      expect(split('packages/*')).toEqual({patterns: [], negatedPatterns: []});
    });
  });

  describe('isWorkspacePathNegated', () => {
    it('matches the excluded directory itself', () => {
      expect(isWorkspacePathNegated('packages/core', ['packages/core'])).toBe(
        true,
      );
      expect(isWorkspacePathNegated('packages/access', ['packages/core'])).toBe(
        false,
      );
    });

    it('treats a /** negation as covering the directory too', () => {
      // npm: ['packages/*','!packages/b/**'] -> a, c (b itself is gone)
      expect(isWorkspacePathNegated('packages/b', ['packages/b/**'])).toBe(
        true,
      );
    });

    it('matches a path outside the root, as workspaceGlobs supplies', () => {
      expect(
        isWorkspacePathNegated('../lincd.org/modules/x', [
          '../lincd.org/modules/x',
        ]),
      ).toBe(true);
    });
  });

  // --- the three walkers ----------------------------------------------------

  /**
   * CN's shape in miniature: `packages/*` plus negations for the untracked
   * checkouts, and one tracked member that must survive.
   */
  function makeMonorepo(root: string) {
    // The root ships src/ too — that is what makes the HMR watcher include the
    // app itself alongside the workspace members.
    makePackage(root, {
      name: 'root',
      private: true,
      workspaces: ['packages/*', '!packages/core', '!packages/primitives'],
      dependencies: {tracked: '1.0.0'},
    });
    makePackage(path.join(root, 'packages', 'tracked'), {
      name: 'tracked',
      linkedPackage: true,
    });
    makePackage(path.join(root, 'packages', 'core'), {
      name: '@_linked/core',
      linkedPackage: true,
    });
    makePackage(path.join(root, 'packages', 'primitives'), {
      name: '@_linked/primitives',
      linkedPackage: true,
    });
  }

  it('discoverWorkspaces skips a negated directory and keeps its siblings', async () => {
    makeMonorepo(tmp);
    const names = (await discoverWorkspaces([], tmp)).map((w) => w.name).sort();
    expect(names).toEqual(['tracked']);
  });

  it('discoverWorkspaces honours a negation in the caller-supplied globs', async () => {
    makeMonorepo(tmp);
    // No own `workspaces` here — exercise the extraGlobs path on its own.
    writeJson(path.join(tmp, 'app', 'package.json'), {name: 'app'});
    const names = (
      await discoverWorkspaces(
        ['../packages/*', '!../packages/core'],
        path.join(tmp, 'app'),
      )
    )
      .map((w) => w.name)
      .sort();
    expect(names).toEqual(['@_linked/primitives', 'tracked']);
  });

  it('getLincdPackages skips a negated directory', () => {
    makeMonorepo(tmp);
    const names = getLincdPackages(tmp)
      .map((p) => p.packageName)
      .sort();
    expect(names).toEqual(['tracked']);
  });

  it('getLincdPackages honours a negation of an exact, non-glob entry', () => {
    writeJson(path.join(tmp, 'package.json'), {
      name: 'root',
      private: true,
      workspaces: ['packages/tracked', 'packages/core', '!packages/core'],
    });
    makePackage(path.join(tmp, 'packages', 'tracked'), {
      name: 'tracked',
      linkedPackage: true,
    });
    makePackage(path.join(tmp, 'packages', 'core'), {
      name: '@_linked/core',
      linkedPackage: true,
    });
    expect(getLincdPackages(tmp).map((p) => p.packageName)).toEqual([
      'tracked',
    ]);
  });

  it('discoverWorkspacePackages (HMR watcher) skips a negated directory', async () => {
    makeMonorepo(tmp);
    const names = (await discoverWorkspacePackages(tmp))
      .map((w) => w.name)
      .sort();
    // The root app itself is always included, plus the one tracked member.
    expect(names).toEqual(['root', 'tracked']);
  });
});
