/**
 * The record of what is localized: the directories themselves.
 *
 * A checkout in `packages-local/` is a workspace member (the app's
 * `workspaces` holds `"packages-local/*"`), so npm links it whatever any file
 * says; a separate record of it could only drift from what npm does. A parked
 * checkout (`linked delocalize`) sits in `.packages-local.parked/`, outside the
 * glob, until `linked localize` takes it back.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readJson} from './fsops.js';

export const LOCAL_DIR = 'packages-local';
export const PARKED_DIR = '.packages-local.parked';

export interface Member {
  name: string;
  version: string;
  /** Relative to the app root, `/`-separated: `packages-local/_linked-core`. */
  dir: string;
}

/** The checkouts npm links: every directory in `packages-local/` with a named `package.json`. */
export function localMembers(appRoot: string): Member[] {
  return membersIn(appRoot, LOCAL_DIR);
}

/** The checkouts `linked delocalize` parked. */
export function parkedMembers(appRoot: string): Member[] {
  return membersIn(appRoot, PARKED_DIR);
}

function membersIn(appRoot: string, dir: string): Member[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(appRoot, dir));
  } catch {
    return [];
  }
  const out: Member[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const pkg = readJson(path.join(appRoot, dir, entry, 'package.json'));
    if (typeof pkg?.name !== 'string' || !pkg.name) continue;
    out.push({
      name: pkg.name,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      dir: `${dir}/${entry}`,
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
