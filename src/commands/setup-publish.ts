import chalk from 'chalk';
import fs from 'fs-extra';
import path, {dirname} from 'path';
import {execp, execPromise} from '../utils.js';

const dirname__ =
  typeof __dirname !== 'undefined'
    ? __dirname
    : //@ts-ignore
      dirname(import.meta.url).replace('file:/', '');

// defaults/setup-publish/ lives at packages/cli/defaults/setup-publish/
// This file compiles to lib/{esm,cjs}/commands/setup-publish.js — go up three
// levels to reach the package root, then into defaults/setup-publish.
const TEMPLATE_ROOT = path.resolve(dirname__, '..', '..', '..', 'defaults', 'setup-publish');

// Both are callers of the shared reusable workflows. `publish.yml` in particular cannot be
// renamed: npm's trusted-publisher check validates the calling workflow's filename, and a
// mismatch only shows up as releases quietly needing manual approval again.
export const WORKFLOW_FILES = ['pr.yml', 'publish.yml'] as const;

/**
 * The uniform branch-protection profile every `@_linked` repo runs on `main`.
 *
 * The required check is `checks / Build & Test`, not `Build & Test`: GitHub reports a job invoked
 * through `workflow_call` as `<caller-job-id> / <job name>`, and the caller job in pr.yml is
 * `checks`. A repo pinning the bare name waits forever on a check that never reports.
 */
export function buildBranchProtectionPayload() {
  return {
    required_status_checks: {strict: false, contexts: ['checks / Build & Test']},
    // Admins included: the point of the gate is that no release skips the build, and the people
    // most likely to push straight to main are the admins.
    enforce_admins: true,
    // Reviews enabled but zero approvals required. The publish workflow direct-merges the version
    // PR (GitHub's auto-merge queue does not honor review-bypass allowances), so a non-zero count
    // would stall every release; the block itself still has to exist for the profile to match.
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

export type SetupPublishOptions = {
  configureGithub?: boolean;
  scope?: 'core' | 'community'; // which NPM secret name to use
  /**
   * @deprecated The dual-branch (`main` + `dev`) flow and its `@next` prereleases are retired —
   * every package repo is `main`-only. Kept as an accepted no-op rather than removed because
   * commander aborts the whole command on an unknown option, so a stale script or copied
   * command line would fail to set the repo up at all instead of setting it up correctly.
   */
  dualBranch?: boolean;
  grantTeam?: string; // GitHub team slug to grant push access on the repo
};

/**
 * Set up the changesets publish pipeline in the current package repo.
 *
 * The workflows are thin callers of the shared reusable workflows in `linked-fw/.github`
 * (pinned `@v1`, a deliberately moving tag) — one edit there changes every package's pipeline,
 * which is why nothing about the build or publish steps is scaffolded per repo any more.
 *
 * Installs:
 * - .github/workflows/{pr,publish}.yml — caller stubs, nothing else
 * - .changeset/config.json + README.md
 * - .changeset/initial-release.md
 * - .gitignore entries for node_modules, lib, yarn.lock, src-compiled-artifacts
 * - package.json: @changesets/cli + @changesets/changelog-github devDeps,
 *   publishConfig: {access: public}
 * - package-lock.json generated via npm install --package-lock-only
 *
 * With --configure-github: if `gh` CLI is available and authenticated, also applies the uniform
 * branch-protection profile on main and enables auto-merge.
 */
export async function setupPublish(opts: SetupPublishOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const scope = opts.scope || 'core';
  const npmSecretName = scope === 'community' ? 'NPM_AUTH_TOKEN_CM' : 'NPM_AUTH_TOKEN';

  console.log(chalk.magenta('Setting up the publish pipeline (main only)...'));
  if (opts.dualBranch) {
    console.log(
      chalk.yellow(
        '  ⚠ --dual-branch is deprecated and ignored: the main + dev flow and its @next prereleases are retired.',
      ),
    );
  }
  console.log(`  target: ${cwd}`);
  console.log(`  npm secret: ${npmSecretName} (${scope})`);

  const pkgJsonPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    console.error(chalk.red('No package.json found in current directory. Run from the repo root.'));
    process.exit(1);
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const repoSlug = await resolveRepoSlug(cwd, pkgJson);

  console.log(`  repo: ${repoSlug}`);
  console.log('');

  // 1. Workflow files (with {{NPM_SECRET_NAME}} substitution in publish.yml)
  await copyWorkflows(cwd, npmSecretName);

  // 2. Changesets config + README
  await copyChangesetConfig(cwd, repoSlug);

  // 3. Initial changeset
  await writeInitialChangeset(cwd, pkgJson.name);

  // 4. .gitignore
  await updateGitignore(cwd);

  // 5. package.json patches
  await patchPackageJson(pkgJsonPath, pkgJson, repoSlug);

  // 6. npm install --package-lock-only to generate lockfile (if not present)
  await ensureLockfile(cwd);

  // 7. Optional: configure GitHub branch protection
  if (opts.configureGithub) {
    await configureGithub(repoSlug);
  }

  // 8. Optional: grant a GitHub team push access
  if (opts.grantTeam) {
    await grantTeamAccess(repoSlug, opts.grantTeam);
  }

  // Summary + manual steps
  printNextSteps(repoSlug, npmSecretName, opts.configureGithub, opts.grantTeam);
}

async function resolveRepoSlug(cwd: string, pkgJson: any): Promise<string> {
  // Try git remote first
  try {
    const remoteUrl = await execPromise('git config --get remote.origin.url', false, false, {cwd});
    const m = typeof remoteUrl === 'string' ? remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/) : null;
    if (m) return m[1];
  } catch {
    // fall through
  }
  // Fallback: parse package.json repository
  const repoField = pkgJson.repository;
  if (typeof repoField === 'string') {
    const m = repoField.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } else if (repoField?.url) {
    const m = repoField.url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  console.warn(chalk.yellow('Could not determine repo slug. Using placeholder "OWNER/REPO" — update .changeset/config.json manually.'));
  return 'OWNER/REPO';
}

async function copyWorkflows(cwd: string, npmSecretName: string): Promise<void> {
  const srcDir = path.join(TEMPLATE_ROOT, 'github', 'workflows');
  const dstDir = path.join(cwd, '.github', 'workflows');
  fs.mkdirpSync(dstDir);

  for (const file of WORKFLOW_FILES) {
    let content = fs.readFileSync(path.join(srcDir, file), 'utf8');
    content = content.replace(/\{\{NPM_SECRET_NAME\}\}/g, npmSecretName);
    fs.writeFileSync(path.join(dstDir, file), content);
    console.log(chalk.green('  ✓') + ` .github/workflows/${file}`);
  }

  // ci.yml and changeset-check.yml became the two jobs of the shared pr.yml. Left behind on a
  // repo that was set up before the consolidation they keep running, so the old bare
  // `Build & Test` check reports alongside `checks / Build & Test` and re-setting a repo up
  // looks like it worked while the duplicate gate quietly stays.
  for (const stale of ['ci.yml', 'changeset-check.yml']) {
    const stalePath = path.join(dstDir, stale);
    if (fs.existsSync(stalePath)) {
      fs.removeSync(stalePath);
      console.log(chalk.green('  ✓') + ` removed superseded .github/workflows/${stale}`);
    }
  }
}

async function copyChangesetConfig(cwd: string, repoSlug: string): Promise<void> {
  const srcDir = path.join(TEMPLATE_ROOT, 'changeset');
  const dstDir = path.join(cwd, '.changeset');
  fs.mkdirpSync(dstDir);

  let configContent = fs.readFileSync(path.join(srcDir, 'config.json'), 'utf8');
  configContent = configContent.replace(/\{\{REPO_SLUG\}\}/g, repoSlug);
  fs.writeFileSync(path.join(dstDir, 'config.json'), configContent);
  console.log(chalk.green('  ✓') + ' .changeset/config.json');

  fs.copyFileSync(path.join(srcDir, 'README.md'), path.join(dstDir, 'README.md'));
  console.log(chalk.green('  ✓') + ' .changeset/README.md');
}

async function writeInitialChangeset(cwd: string, pkgName: string): Promise<void> {
  const changelogPath = path.join(cwd, 'CHANGELOG.md');
  if (fs.existsSync(changelogPath)) {
    console.log(chalk.gray('  · CHANGELOG.md exists — skipping initial changeset'));
    return;
  }
  const initial = path.join(cwd, '.changeset', 'initial-release.md');
  const body = `---\n'${pkgName}': patch\n---\n\nInitial release under the new publishing setup.\n`;
  fs.writeFileSync(initial, body);
  console.log(chalk.green('  ✓') + ' .changeset/initial-release.md');
}

async function updateGitignore(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore');
  const entries = [
    'node_modules/',
    'lib/',
    'yarn.lock',
    '*.log',
    '.DS_Store',
    '',
    '# tsc sourcemap output — always in lib/, never src/.',
    '# (.d.ts not ignored — hand-written type declarations like colors.d.ts',
    '#  are legit src files.)',
    'src/**/*.js.map',
  ];
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8').split('\n')
    : [];
  const existingSet = new Set(existing.map((l) => l.trim()));
  const toAdd = entries.filter((e) => e && !existingSet.has(e.trim()));
  if (toAdd.length === 0) {
    console.log(chalk.gray('  · .gitignore already has all entries'));
    return;
  }
  const merged = [
    ...existing.filter((l) => l.trim() !== ''),
    '',
    ...entries,
  ].join('\n');
  fs.writeFileSync(gitignorePath, merged + '\n');
  console.log(chalk.green('  ✓') + ' .gitignore');
}

async function patchPackageJson(
  pkgJsonPath: string,
  pkgJson: any,
  repoSlug: string,
): Promise<void> {
  if (applyPackageJsonPatches(pkgJson, repoSlug)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
    console.log(chalk.green('  ✓') + ' package.json (publishConfig + changesets devDeps)');
  } else {
    console.log(chalk.gray('  · package.json already configured'));
  }
}

/** Mutates `pkgJson` in place; returns whether anything changed. Pure enough to test. */
export function applyPackageJsonPatches(pkgJson: any, repoSlug: string): boolean {
  let modified = false;

  // `repository.url` must be set, and must match the repo the workflow builds in.
  //
  // `create-package` scaffolds it EMPTY, and npm rejects a provenance-signed publish whose
  // attestation cannot be matched against it:
  //
  //   422 Error verifying sigstore provenance bundle: Failed to validate repository
  //   information: package.json "repository.url" is "", expected to match <repo>
  //
  // The slug is already resolved from `git remote` above, so there is no reason to leave a
  // package to discover this at its first release.
  if (repoSlug !== 'OWNER/REPO') {
    const url = `git+https://github.com/${repoSlug}.git`;
    const current =
      typeof pkgJson.repository === 'string'
        ? pkgJson.repository
        : pkgJson.repository?.url;
    if (!current) {
      pkgJson.repository = {type: 'git', url};
      modified = true;
    }
  }

  if (!pkgJson.publishConfig) {
    pkgJson.publishConfig = {access: 'public'};
    modified = true;
  } else {
    if (pkgJson.publishConfig.access !== 'public') {
      pkgJson.publishConfig.access = 'public';
      modified = true;
    }
    // `provenance` is deliberately left alone. It used to be stripped because publishing went
    // through NPM_AUTH_TOKEN only; the shared workflow now publishes with OIDC trusted publishing
    // first (`npm publish --provenance`, id-token: write on both caller and reusable workflow) and
    // falls back to the staged token release, so provenance is wanted, not a conflict.
  }

  pkgJson.devDependencies = pkgJson.devDependencies || {};
  if (!pkgJson.devDependencies['@changesets/cli']) {
    pkgJson.devDependencies['@changesets/cli'] = '^2.29.8';
    modified = true;
  }
  if (!pkgJson.devDependencies['@changesets/changelog-github']) {
    pkgJson.devDependencies['@changesets/changelog-github'] = '^0.5.2';
    modified = true;
  }

  return modified;
}

async function ensureLockfile(cwd: string): Promise<void> {
  // Always regenerate — package.json has just been patched (new devDeps etc.),
  // so any existing lockfile is stale.
  console.log(chalk.magenta('  Running npm install --package-lock-only...'));

  // When running inside a yarn workspace (e.g. CN's packages/* layout), npm
  // climbs up, detects the parent workspace, and writes the lockfile at the
  // wrong level. Work around by copying the package to a tmpdir, generating
  // the lockfile in isolation, and copying it back.
  const os = await import('os');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-setup-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-setup-cache-'));
  try {
    const pkgJsonPath = path.join(cwd, 'package.json');
    fs.copyFileSync(pkgJsonPath, path.join(tmpBase, 'package.json'));
    await execp(
      `npm install --legacy-peer-deps --package-lock-only --cache ${cacheDir}`,
      false,
      true,
      {cwd: tmpBase},
    );
    const lockPath = path.join(tmpBase, 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      fs.copyFileSync(lockPath, path.join(cwd, 'package-lock.json'));
      console.log(chalk.green('  ✓') + ' package-lock.json');
    } else {
      console.warn(chalk.yellow('  ⚠ npm install did not produce a package-lock.json — likely because a dependency is not yet published on npm.'));
      console.warn(chalk.yellow('    Regenerate manually once all deps are published: `npm install --package-lock-only`.'));
    }
  } catch (err) {
    console.warn(chalk.yellow('  ⚠ Failed to generate package-lock.json — likely because a dependency is not yet published on npm.'));
    console.warn(chalk.yellow('    Regenerate manually once all deps are published: `npm install --package-lock-only`.'));
  } finally {
    fs.removeSync(tmpBase);
    fs.removeSync(cacheDir);
  }
}

async function configureGithub(repoSlug: string): Promise<void> {
  console.log('');
  console.log(chalk.magenta('Configuring GitHub (branch protection)...'));

  // Check gh CLI available
  try {
    await execPromise('gh --version', false, false);
  } catch {
    console.warn(chalk.yellow('  ⚠ `gh` CLI not found. Install from https://cli.github.com/ and retry with --configure-github,'));
    console.warn(chalk.yellow('    or set branch protection manually at https://github.com/' + repoSlug + '/settings/branches'));
    return;
  }

  // Check gh CLI authenticated
  try {
    await execPromise('gh auth status', false, false);
  } catch {
    console.warn(chalk.yellow('  ⚠ `gh` CLI is not authenticated. Run `gh auth login` and retry.'));
    return;
  }

  const payload = JSON.stringify(buildBranchProtectionPayload());

  try {
    // Use --input - to pass the JSON payload via stdin
    await execPromise(
      `echo '${payload.replace(/'/g, "'\\''")}' | gh api -X PUT /repos/${repoSlug}/branches/main/protection --input -`,
      false,
      false,
    );
    console.log(chalk.green('  ✓') + ` branch protection enabled on ${repoSlug}/main`);
    // A repo can pin a required check in a *ruleset* as well as in classic branch protection, and
    // the two are stored separately — this call only writes the classic one, so a leftover ruleset
    // keeps blocking merges on a check name that no longer reports.
    console.log(
      chalk.gray(`  · check for a competing ruleset: gh api /repos/${repoSlug}/rulesets`),
    );
  } catch (err) {
    console.warn(chalk.yellow('  ⚠ Failed to set branch protection. Do it manually:'));
    console.warn(chalk.yellow(`    https://github.com/${repoSlug}/settings/branches`));
  }

  // Enable "Allow auto-merge" so a PR can be queued to merge itself once checks pass. The publish
  // workflow authors the Release PR via the org App token (org secrets RELEASE_APP_ID /
  // RELEASE_APP_PRIVATE_KEY) so its CI runs without a manual approval gate.
  try {
    await execPromise(
      `gh api -X PATCH /repos/${repoSlug} -F allow_auto_merge=true`,
      false,
      false,
    );
    console.log(chalk.green('  ✓') + ` auto-merge enabled on ${repoSlug}`);
  } catch (err) {
    console.warn(chalk.yellow('  ⚠ Failed to enable auto-merge. Enable it manually:'));
    console.warn(chalk.yellow(`    https://github.com/${repoSlug}/settings (General → Allow auto-merge)`));
  }
}

async function grantTeamAccess(repoSlug: string, teamSlug: string): Promise<void> {
  console.log('');
  console.log(chalk.magenta(`Granting '${teamSlug}' team push access to ${repoSlug}...`));

  try {
    await execPromise('gh --version', false, false);
  } catch {
    console.warn(chalk.yellow("  ⚠ `gh` CLI not found. Install from https://cli.github.com/ and retry with --grant-team,"));
    console.warn(chalk.yellow(`    or add the team manually at https://github.com/${repoSlug}/settings/access`));
    return;
  }

  const [owner, repo] = repoSlug.split('/');
  try {
    await execPromise(
      `gh api -X PUT /orgs/${owner}/teams/${teamSlug}/repos/${owner}/${repo} -f permission=push`,
      false,
      false,
    );
    console.log(chalk.green('  ✓') + ` team '${teamSlug}' granted push access on ${repoSlug}`);
  } catch (err: any) {
    const msg = err?.stderr || err?.stdout || String(err);
    console.warn(chalk.yellow(`  ⚠ Failed to grant team access: ${msg.slice(0, 200)}`));
    console.warn(chalk.yellow(`    Team may not exist in org '${owner}', or you may lack admin rights.`));
    console.warn(chalk.yellow(`    Manual: https://github.com/${repoSlug}/settings/access`));
  }
}

function printNextSteps(
  repoSlug: string,
  npmSecretName: string,
  configuredGithub: boolean | undefined,
  grantedTeam: string | undefined,
): void {
  console.log('');
  console.log(chalk.green('Done.'));
  console.log('');
  console.log(chalk.bold('Next steps:'));
  console.log('');
  const [owner, repo] = repoSlug.split('/');

  console.log(`  1. Review the generated files, adjust as needed.`);
  console.log(`  2. Commit:`);
  console.log(chalk.cyan('       git add . && git commit -m "set up the publish pipeline"'));
  console.log(`  3. Push to main — the publish workflow will trigger.`);
  console.log('');
  console.log(chalk.bold('Register the trusted publisher on npmjs.com (before the first release):'));
  console.log('');
  console.log(`  package → Settings → Trusted Publisher, matching the caller workflow exactly:`);
  console.log(`    organization: ${chalk.cyan(owner)}   repository: ${chalk.cyan(repo)}`);
  console.log(`    workflow filename: ${chalk.cyan('publish.yml')}   environment: ${chalk.cyan('(empty)')}`);
  console.log(`    "Allow npm publish": ${chalk.cyan('ticked')}`);
  console.log('');
  console.log(chalk.gray(`  Without it the release still ships — the workflow falls back to a staged`));
  console.log(chalk.gray(`  npm release that a maintainer approves with 2FA. A typo in the organization`));
  console.log(chalk.gray(`  field looks exactly the same, so check that field first if a package that`));
  console.log(chalk.gray(`  should publish directly keeps staging instead.`));
  console.log('');
  // No per-repo secret grant step: NPM_AUTH_TOKEN, RELEASE_APP_ID and RELEASE_APP_PRIVATE_KEY are
  // "All repositories" org secrets, which is the whole reason first-party and community packages
  // live in separate orgs. Only mention what is genuinely still one-time-per-org.
  console.log(chalk.bold('One-time org-level setup (already done on linked-fw):'));
  console.log('');
  console.log(`  a. Org secrets ${chalk.cyan(npmSecretName)}, ${chalk.cyan('RELEASE_APP_ID')} and ${chalk.cyan('RELEASE_APP_PRIVATE_KEY')},`);
  console.log(`     visible to ${chalk.cyan('All repositories')} — there is no per-repo grant step.`);
  console.log(`     → https://github.com/organizations/${owner}/settings/secrets/actions`);
  console.log('');
  console.log(`  b. Enable "Allow GitHub Actions to create and approve pull requests":`);
  console.log(`     → https://github.com/organizations/${owner}/settings/actions`);

  if (!configuredGithub) {
    console.log('');
    console.log(chalk.bold('Branch protection:'));
    console.log(`  Rerun with ${chalk.cyan('linked setup-publish --configure-github')} to configure automatically,`);
    console.log(`  or set manually at https://github.com/${repoSlug}/settings/branches —`);
    console.log(`  the required check is ${chalk.cyan('checks / Build & Test')}, not ${chalk.cyan('Build & Test')}.`);
  }
  console.log('');
}
