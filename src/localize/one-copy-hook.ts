/**
 * Which `linked` commands run the one-copy check (`checkOneCopy`, ensure.ts)
 * first: the ones that run the app's code. Kept apart from `cli.ts`, which
 * builds and parses the real program on import, so a test can install the
 * hook on a program of its own and see exactly which commands trigger it.
 */
import type {Command} from 'commander';

import {checkOneCopy} from './ensure.js';

/** `linked start`, `script`, `call` and `build-all`, and nothing else. */
export const ONE_COPY_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'script',
  'call',
  'build-all',
]);

/**
 * Before one of `ONE_COPY_COMMANDS`, remove any localized checkout's own copy
 * of what the app provides. Never runs npm, silent when there is nothing to
 * remove, a no-op with no local-packages.json, and it never throws.
 */
export function installOneCopyHook(
  program: Command,
  check: (appRoot: string) => unknown = checkOneCopy,
): void {
  program.hook('preAction', (_program, actionCommand) => {
    if (ONE_COPY_COMMANDS.has(actionCommand.name())) check(process.cwd());
  });
}
