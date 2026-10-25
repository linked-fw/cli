/**
 * The executable bit on a package's `bin` files. npm sets it when it links a
 * bin at install time; a rebuild that rewrites `lib/` (`linked build`) drops
 * it, and a bin run through a link, not through npm (the `.bin` of a
 * worktree's `node_modules` link farm), then fails with "Permission denied".
 */
import fs from 'node:fs';
import path from 'node:path';

/** The files `pkg.bin` names, relative to the package. */
export function binFiles(pkg: {bin?: unknown} | null): string[] {
  const bin = pkg?.bin;
  if (typeof bin === 'string') return [bin];
  if (bin && typeof bin === 'object') {
    return Object.values(bin as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/**
 * Give each existing `bin` file of the package at `packageDir` the execute bit
 * wherever it has the read bit, as npm does; returns the files it changed.
 * A no-op on Windows, which has no such bit.
 */
export function makeBinsExecutable(packageDir: string): string[] {
  if (process.platform === 'win32') return [];
  let pkg: {bin?: unknown} | null = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  const changed: string[] = [];
  for (const rel of binFiles(pkg)) {
    const file = path.join(packageDir, rel);
    let mode: number;
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      continue;
    }
    const wanted = mode | ((mode & 0o444) >> 2);
    if (wanted !== mode) {
      fs.chmodSync(file, wanted);
      changed.push(rel);
    }
  }
  return changed;
}
