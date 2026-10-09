#!/usr/bin/env node
// One React for the app: `react` resolved from apps/mobile, from the installed @_linked/react and from react-native
// must be the same file. It checks resolution rather than `npm ls react`, because what matters is the file each
// of them loads: a second copy nested under apps/mobile (see the README) passes `npm ls` and still splits React.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '19.2.3';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDir = join(repoRoot, 'apps/mobile');

const failures = [];

/** Resolves `react`'s entry file as Node would from `fromDir`, following symlinks. */
function resolveReact(fromDir) {
  const require = createRequire(join(fromDir, 'noop.js'));
  return realpathSync(require.resolve('react'));
}

/** Finds an installed package's directory from `fromDir` by the node_modules walk (works when exports hide package.json). */
function packageDir(name, fromDir) {
  const require = createRequire(join(fromDir, 'noop.js'));
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = join(base, name);
    if (existsSync(join(dir, 'package.json'))) return realpathSync(dir);
  }
  return null;
}

const appReact = resolveReact(mobileDir);
const appReactPkg = JSON.parse(readFileSync(join(dirname(appReact), 'package.json'), 'utf8'));
console.log(`apps/mobile          -> react@${appReactPkg.version} ${appReact}`);
if (appReactPkg.version !== EXPECTED_VERSION) {
  failures.push(`apps/mobile resolves react@${appReactPkg.version}, expected ${EXPECTED_VERSION}.`);
}

for (const name of ['@_linked/react', 'react-native']) {
  const dir = packageDir(name, mobileDir);
  if (!dir) {
    failures.push(`${name} is not installed where apps/mobile can resolve it.`);
    continue;
  }
  const react = resolveReact(dir);
  console.log(`${name.padEnd(20)} -> ${react}`);
  if (react !== appReact) failures.push(`${name} (${dir}) resolves a different react: ${react}`);
}

if (failures.length) {
  console.error('\ncheck:react FAILED: the app would load more than one React.');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\ncheck:react OK: one React for the app.');
