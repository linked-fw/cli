/**
 * Filesystem rules that differ on Windows, in one place: path identity
 * (case-insensitive, either separator), directory links (junctions, which
 * need no administrator rights or Developer Mode), `import()` of a path (a
 * `file:` URL, since `C:\…` reads as a URL scheme) and line endings kept when
 * a file is rewritten. Each takes the platform so tests can ask for the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const pathFor = (platform: NodeJS.Platform) =>
  platform === 'win32' ? path.win32 : path.posix;

/** Paths as compared on `platform`: resolved, and lower-cased where the filesystem ignores case. */
function comparable(p: string, platform: NodeJS.Platform): string {
  const resolved = pathFor(platform).resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Do `a` and `b` name the same path on `platform`? No filesystem access. */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return comparable(a, platform) === comparable(b, platform);
}

/** Is `child` at or below `parent` on `platform`? No filesystem access. */
export function isPathInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = pathFor(platform);
  const rel = p.relative(
    comparable(parent, platform),
    comparable(child, platform),
  );
  // `..foo` is a child named `..foo`; only `..` itself or a `../` prefix leaves `parent`.
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel))
  );
}

/**
 * Link `linkPath` to the directory `target`. On Windows a junction, with an
 * absolute target (a junction cannot be relative); elsewhere a relative
 * symlink, so moving the app keeps it working.
 */
export function linkDirectory(
  target: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
  symlink: (
    target: string,
    linkPath: string,
    type: 'dir' | 'junction',
  ) => void = fs.symlinkSync,
): void {
  if (platform === 'win32') {
    symlink(path.win32.resolve(target), linkPath, 'junction');
    return;
  }
  symlink(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
}

/**
 * What to pass to `import()` for the absolute path `file`: on Windows its
 * `file:` URL (`import('C:\\x.js')` fails: `c:` reads as a URL scheme);
 * elsewhere the path itself, which Node takes as it is.
 */
export function importSpecifier(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return file;
  return pathToFileURL(path.win32.resolve(file), {windows: true}).href;
}

/** `import()` of a file by its absolute path. */
export function importFile<T = any>(file: string): Promise<T> {
  return import(/* @vite-ignore */ importSpecifier(file));
}

/**
 * `text` with the line endings of `original`: CRLF throughout when `original`
 * uses CRLF (a checkout with `core.autocrlf`), else `text` unchanged.
 */
export function withEolOf(text: string, original: string): string {
  return original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}
