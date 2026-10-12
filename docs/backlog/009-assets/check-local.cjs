// One copy of every localized package, every declared range satisfied, and no nested copy of the
// app-wide singletons. Reads npm's hidden lockfile (node_modules/.package-lock.json): the committed
// package-lock.json is kept as the registry lockfile and does not describe the localized tree.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const semver = require(require.resolve('semver', {paths: [root]}));
const SINGLETONS = ['@_linked/core', '@_linked/react', '@_linked/server-utils'];
const hidden = path.join(root, 'node_modules/.package-lock.json');
if (!fs.existsSync(hidden)) { console.error('check-local: no node_modules/.package-lock.json (run npm install)'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(hidden, 'utf8')).packages;
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p, 'package.json'), 'utf8'));
const members = {};
for (const k of Object.keys(lock)) if (/^packages-local\/[^/]+$/.test(k)) {
  if (!fs.existsSync(path.join(root, k, 'package.json'))) { members['?' + k] = {dir: k, missing: true}; continue; }
  const pj = rd(k); members[pj.name] = {dir: k, version: pj.version};
}
const problems = [];
for (const [n, m] of Object.entries(members)) if (m.missing) problems.push(`member dir missing: ${m.dir}`);
for (const k of Object.keys(lock)) {
  const m = k.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  if (!m || k === 'node_modules/' + m[1]) continue;
  if (members[m[1]]) problems.push(`second copy of localized ${m[1]}@${lock[k].version} at ${k}`);
  else if (SINGLETONS.includes(m[1])) problems.push(`second copy of singleton ${m[1]}@${lock[k].version} at ${k}`);
}
// importers: root, packages/*, packages-local/* -- read live manifests (the hidden lock may lag)
const importers = ['.', ...Object.keys(lock).filter((k) => /^packages(-local)?\/[^/]+$/.test(k) && fs.existsSync(path.join(root, k, 'package.json')))];
for (const k of importers) {
  const pj = rd(k);
  for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
    for (const [n, r] of Object.entries(pj[f] || {})) {
      const mm = members[n];
      if (mm && !mm.missing && !semver.satisfies(mm.version, r, {includePrerelease: true}))
        problems.push(`${n}@${mm.version} (${mm.dir}) does not satisfy ${f} "${r}" of ${k === '.' ? '<root>' : k}`);
    }
}
if (problems.length) { console.error('check-local: ' + problems.join('\ncheck-local: ')); process.exit(1); }
const names = Object.keys(members);
console.log(names.length ? 'check-local OK: ' + names.join(', ') : 'check-local OK: nothing localized');
