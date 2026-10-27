import * as minimatchModule from 'minimatch';

type Minimatch = typeof minimatchModule.minimatch;

/**
 * `minimatch`, from whichever copy Node resolves. A namespace import, not `import {minimatch}`: a
 * named import is checked when the module links, and a CommonJS copy (3.x, which an app's install
 * may hoist where the cli resolves it) has no `minimatch` export, so the whole cli would fail to
 * load. Its function is the module itself (`default`); 9.x and later export it by name.
 */
const resolveMinimatch = (): Minimatch => {
  const mod = minimatchModule as unknown as {
    minimatch?: Minimatch;
    default?: Minimatch | {minimatch?: Minimatch};
  };
  const fromDefault = typeof mod.default === 'function' ? mod.default : mod.default?.minimatch;
  const found = mod.minimatch ?? fromDefault;
  if (!found) throw new Error('the installed minimatch exports no minimatch function');
  return found;
};

export const minimatch: Minimatch = resolveMinimatch();
