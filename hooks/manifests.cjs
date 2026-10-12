// What the hooks and the drift check need to know about the app's own manifests: its workspace
// globs, the git pathspecs of every dependency manifest they cover, its checkouts, and what a
// leaked checkout looks like in a committed manifest.
// Plain, unbuilt CommonJS with Node built-ins only, like the other files in hooks/.
'use strict';
const fs = require('fs');
const path = require('path');

const LOCAL_DIR = 'packages-local';

// A committed package.json or package-lock.json that lists a checkout: "packages-local/<dir>".
// The glob "packages-local/*" itself is the committed setup and is allowed.
const LEAK = /"packages-local\/(?!\*")/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The app's `workspaces` globs as written (the array, or yarn's `{packages: [...]}`, which npm
 * reads too), or null when it has none or its package.json cannot be read.
 */
function workspaceGlobs(appRoot) {
  const pkg = readJson(path.join(appRoot, 'package.json'));
  const ws = pkg && pkg.workspaces;
  const globs = Array.isArray(ws)
    ? ws
    : ws && Array.isArray(ws.packages)
      ? ws.packages
      : null;
  return globs ? globs.filter((g) => typeof g === 'string' && g !== '') : null;
}

// A glob without its leading `./` and trailing slashes; null for a negation or a checkout glob.
function trackedGlob(glob) {
  if (glob.startsWith('!')) return null;
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  if (g === '' || g === LOCAL_DIR || g.startsWith(`${LOCAL_DIR}/`)) return null;
  return g;
}

/**
 * The workspace globs that hold tracked members: every glob but the checkouts' own. `fallback` is
 * what an app without `workspaces` gets.
 */
function trackedGlobs(appRoot, fallback = []) {
  const globs = workspaceGlobs(appRoot);
  const out = [];
  for (const glob of globs || fallback) {
    const g = trackedGlob(glob);
    if (g !== null && !out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * The git pathspecs, relative to the app directory, of the manifests whose change is a change of
 * dependencies: `package.json` and `<glob>/package.json` for each workspace glob except
 * `packages-local/*` (checkouts are not committed).
 */
function manifestPathspecs(appRoot) {
  return [
    'package.json',
    ...trackedGlobs(appRoot).map((g) => `${g}/package.json`),
  ];
}

/** One glob segment (`*`, `?`, literal text) as a regular expression. */
function segmentRegExp(segment) {
  const body = segment
    .split('')
    .map((c) =>
      c === '*'
        ? '[^/]*'
        : c === '?'
          ? '[^/]'
          : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * The directories, relative to the app and sorted per glob, that `globs` match and that hold a
 * package.json. Globs are matched one path segment at a time; `**` matches any depth below it
 * (node_modules and dot directories excepted).
 */
function expandGlobs(appRoot, globs) {
  const found = [];
  const walk = (rel, segments) => {
    if (!segments.length) {
      if (
        rel &&
        fs.existsSync(path.join(appRoot, rel, 'package.json')) &&
        !found.includes(rel)
      )
        found.push(rel);
      return;
    }
    const [segment, ...rest] = segments;
    if (!/[*?]/.test(segment))
      return walk(rel ? `${rel}/${segment}` : segment, rest);
    let entries = [];
    try {
      entries = fs
        .readdirSync(path.join(appRoot, rel), {withFileTypes: true})
        .filter(
          (e) =>
            (e.isDirectory() || e.isSymbolicLink()) &&
            !e.name.startsWith('.') &&
            e.name !== 'node_modules',
        )
        .map((e) => e.name)
        .sort();
    } catch {
      return;
    }
    if (segment === '**') {
      walk(rel, rest);
      for (const name of entries) walk(rel ? `${rel}/${name}` : name, segments);
      return;
    }
    const re = segmentRegExp(segment);
    for (const name of entries)
      if (re.test(name)) walk(rel ? `${rel}/${name}` : name, rest);
  };
  for (const glob of globs) walk('', glob.split('/'));
  return found;
}

/**
 * Do the workspace `globs` match `rel` (a directory relative to the app, `/`-separated) the way
 * `expandGlobs` would find it -- `*` and `?` within a segment, `**` across any depth, never into
 * node_modules or a dot directory -- and does no negation (`!glob`) exclude it?
 */
function globsMatch(globs, rel) {
  const target = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (!target.length) return false;
  const matches = (segments, names) => {
    if (!segments.length) return !names.length;
    const [segment, ...rest] = segments;
    if (segment === '**') {
      if (matches(rest, names)) return true;
      return (
        names.length > 0 &&
        wildcardName(names[0]) &&
        matches(segments, names.slice(1))
      );
    }
    if (!names.length) return false;
    if (/[*?]/.test(segment)) {
      if (!wildcardName(names[0]) || !segmentRegExp(segment).test(names[0]))
        return false;
    } else if (segment !== names[0]) return false;
    return matches(rest, names.slice(1));
  };
  const split = (g) =>
    g
      .replace(/^\.\//, '')
      .replace(/\/+$/, '')
      .split('/')
      .filter((s) => s !== '');
  let included = false;
  for (const glob of globs) {
    if (glob.startsWith('!')) {
      if (matches(split(glob.slice(1)), target)) return false;
    } else if (!included && matches(split(glob), target)) included = true;
  }
  return included;
}

// What a wildcard segment may stand for: not node_modules, not a dot directory.
function wildcardName(name) {
  return !name.startsWith('.') && name !== 'node_modules';
}

/**
 * The checkouts npm links: every directory in `packages-local/` with a named package.json, as
 * `{name, version, dir}` with `dir` app-relative, sorted by name.
 */
function localMembers(appRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(appRoot, LOCAL_DIR));
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const pkg = readJson(path.join(appRoot, LOCAL_DIR, entry, 'package.json'));
    if (!pkg || typeof pkg.name !== 'string' || !pkg.name) continue;
    out.push({
      name: pkg.name,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      dir: `${LOCAL_DIR}/${entry}`,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

module.exports = {
  LOCAL_DIR,
  LEAK,
  readJson,
  workspaceGlobs,
  trackedGlobs,
  manifestPathspecs,
  expandGlobs,
  globsMatch,
  localMembers,
};
