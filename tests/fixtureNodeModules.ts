import fs from 'fs';
import path from 'path';

/**
 * A `node_modules` for a compiled-package fixture: `@_linked/core` linked to the
 * copy Node resolves from this repository — the nearest `node_modules/@_linked/core`
 * at or above it, the walk `jest.config.cjs` does too.
 *
 * Not a symlink to `<cli>/node_modules` itself: when this repository is a localized
 * checkout, `linked localize` removes its own copy of what the app provides, and
 * core then lives in the app's `node_modules` above it.
 */
export function fixtureNodeModules(dir: string): void {
  let from = path.resolve(__dirname, '..');
  let core: string | undefined;
  for (;;) {
    const candidate = path.join(from, 'node_modules', '@_linked', 'core');
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      core = fs.realpathSync(candidate);
      break;
    }
    const parent = path.dirname(from);
    if (parent === from)
      throw new Error(
        'no @_linked/core above ' + __dirname + ' — run an install first',
      );
    from = parent;
  }
  const scope = path.join(dir, 'node_modules', '@_linked');
  fs.mkdirSync(scope, {recursive: true});
  fs.symlinkSync(core, path.join(scope, 'core'), 'dir');
}
