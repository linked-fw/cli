// Whether an app directory runs on another checkout's install: a git worktree made by
// `linked worktree add`. Plain, unbuilt CommonJS with Node built-ins only, like the other files in
// hooks/; the git hooks require it, and the cli's src/ loads it through hook-module.ts, so the
// commands and the hooks apply the same rule.
//
// Two layouts share an install:
// - `node_modules` is a symlink to the main checkout's (worktrees made before the link farm);
// - `node_modules` is a link farm: a real directory whose entries link to the main checkout's
//   entries, except the worktree's own `packages-local/` checkouts. It holds MARKER, which names
//   the install it links into.
'use strict';
const fs = require('fs');
const path = require('path');

/** The file in a link farm's `node_modules` that names the install it links into. */
const MARKER = '.linked-worktree.json';

/** The marker of `<appRoot>/node_modules`, or null when there is none or it is unreadable. */
function readMarker(appRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(appRoot, 'node_modules', MARKER), 'utf8'));
    return value && typeof value.installRoot === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * How `<appRoot>/node_modules` shares another checkout's install: null when it is the app's own
 * (or there is none), else `{layout: 'symlink' | 'farm', installRoot}`, where `installRoot` is the
 * directory that holds the real `node_modules`.
 */
function sharedInstall(appRoot) {
  const nodeModules = path.join(appRoot, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(nodeModules);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    let real;
    try {
      real = fs.realpathSync(nodeModules);
    } catch {
      real = path.resolve(appRoot, fs.readlinkSync(nodeModules)); // dangling: still not ours to rewrite
    }
    return {layout: 'symlink', installRoot: path.dirname(real)};
  }
  const marker = readMarker(appRoot);
  return marker ? {layout: 'farm', installRoot: marker.installRoot} : null;
}

module.exports = {MARKER, readMarker, sharedInstall};
