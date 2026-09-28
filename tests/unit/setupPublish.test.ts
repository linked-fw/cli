import fs from 'fs';
import path from 'path';
import {
  WORKFLOW_FILES,
  applyPackageJsonPatches,
  buildBranchProtectionPayload,
} from '../../src/commands/setup-publish.js';

const templates = path.resolve(__dirname, '..', '..', 'defaults', 'setup-publish');
const workflowDir = path.join(templates, 'github', 'workflows');
const read = (file: string) => fs.readFileSync(path.join(workflowDir, file), 'utf8');

describe('setup-publish workflow templates', () => {
  test('exactly two workflows are scaffolded, both callers of the shared workflows', () => {
    expect(fs.readdirSync(workflowDir).sort()).toEqual(['pr.yml', 'publish.yml']);
    expect([...WORKFLOW_FILES].sort()).toEqual(['pr.yml', 'publish.yml']);
    // The org is substituted per repo (see `copyWorkflows`), so the template carries the
    // placeholder rather than a hardcoded org — a repo in linked-cm must not call linked-fw's
    // workflows.
    for (const file of WORKFLOW_FILES) {
      expect(read(file)).toMatch(
        new RegExp(
          `uses: \\{\\{WORKFLOW_ORG\\}\\}/\\.github/\\.github/workflows/${file.replace('.', '\\.')}@v1`,
        ),
      );
      expect(read(file)).not.toContain('uses: linked-fw/');
    }
  });

  test('the retired per-repo workflows and the dual-branch variant are gone', () => {
    expect(fs.existsSync(path.join(workflowDir, 'ci.yml'))).toBe(false);
    expect(fs.existsSync(path.join(workflowDir, 'changeset-check.yml'))).toBe(false);
    expect(fs.existsSync(path.join(templates, 'dual-branch'))).toBe(false);
  });

  test('no caller inlines build steps of its own', () => {
    for (const file of WORKFLOW_FILES) {
      expect(read(file)).not.toMatch(/runs-on:|actions\/checkout/);
    }
  });

  test('publish.yml passes named secrets and declares id-token: write itself', () => {
    const yml = read('publish.yml');
    expect(yml).toContain('id-token: write');
    expect(yml).not.toContain('secrets: inherit');
    // One secret NAME in every org; the orgs hold different values. The old NPM_AUTH_TOKEN_CM
    // is retired, so there is nothing left to substitute here.
    expect(yml).toContain('NPM_TOKEN: ${{ secrets.NPM_AUTH_TOKEN }}');
    expect(yml).not.toContain('NPM_AUTH_TOKEN_CM');
    expect(yml).not.toContain('{{NPM_SECRET_NAME}}');
    expect(yml).toContain('RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}');
    expect(yml).toContain('RELEASE_APP_PRIVATE_KEY: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
  });

  test('pr.yml grants pull-requests: write and names its job `checks`', () => {
    const yml = read('pr.yml');
    expect(yml).toContain('pull-requests: write');
    // The required check name is derived from this job id — see buildBranchProtectionPayload.
    expect(yml).toMatch(/^ {2}checks:$/m);
  });
});

describe('buildBranchProtectionPayload', () => {
  const payload = buildBranchProtectionPayload();

  test('requires the workflow_call-qualified check name', () => {
    expect(payload.required_status_checks.contexts).toEqual(['checks / Build & Test']);
  });

  test('matches the uniform profile', () => {
    expect(payload.required_status_checks.strict).toBe(false);
    expect(payload.enforce_admins).toBe(true);
    expect(payload.required_pull_request_reviews?.required_approving_review_count).toBe(0);
    expect(payload.allow_force_pushes).toBe(false);
    expect(payload.allow_deletions).toBe(false);
  });
});

describe('applyPackageJsonPatches', () => {
  test('keeps publishConfig.provenance — the pipeline publishes with OIDC', () => {
    const pkg: any = {publishConfig: {access: 'public', provenance: true}, devDependencies: {
      '@changesets/cli': '^2.29.8',
      '@changesets/changelog-github': '^0.5.2',
    }, repository: {type: 'git', url: 'git+https://github.com/linked-fw/owl.git'}};
    expect(applyPackageJsonPatches(pkg, 'linked-fw/owl')).toBe(false);
    expect(pkg.publishConfig.provenance).toBe(true);
  });

  test('sets repository.url and public access, adds the changesets devDeps', () => {
    const pkg: any = {name: '@_linked/owl'};
    expect(applyPackageJsonPatches(pkg, 'linked-fw/owl')).toBe(true);
    expect(pkg.repository).toEqual({type: 'git', url: 'git+https://github.com/linked-fw/owl.git'});
    expect(pkg.publishConfig).toEqual({access: 'public'});
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      '@changesets/changelog-github',
      '@changesets/cli',
    ]);
  });

  test('leaves repository.url alone when the slug could not be resolved', () => {
    const pkg: any = {name: '@_linked/owl'};
    applyPackageJsonPatches(pkg, 'OWNER/REPO');
    expect(pkg.repository).toBeUndefined();
  });
});
