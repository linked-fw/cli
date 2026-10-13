/**
 * Which `linked` commands report drift (drift.ts) first: the ones that run
 * the app's code. Kept apart from `cli.ts`, which builds and parses the real
 * program on import, so a test can install the hook on a program of its own
 * and see exactly which commands trigger it.
 */
import type {Command} from 'commander';

import {findAppRoot} from './app-root.js';
import {describeDrift, driftProblems} from './drift.js';

/** `linked start`, `script`, `call` and `build-all`, and nothing else. */
export const DRIFT_COMMANDS: ReadonlySet<string> = new Set([
  'start',
  'script',
  'call',
  'build-all',
]);

/** Print each drift line for the app at `appRoot` on stderr. Never throws. */
export function reportDrift(
  appRoot: string,
  warn: (line: string) => void = (line) => console.warn(line),
): void {
  try {
    for (const d of driftProblems(appRoot))
      warn(`[localize] drift: ${describeDrift(d)}`);
  } catch {
    /* a report must never cost the command it precedes */
  }
}

/**
 * Before one of `DRIFT_COMMANDS`, report drift for the app the command runs
 * in (its workspace root, not the member it may run from). Silent when there is none or
 * nothing is installed; never fails the command.
 */
export function installDriftHook(
  program: Command,
  report: (appRoot: string) => void = reportDrift,
): void {
  program.hook('preAction', (_program, actionCommand) => {
    if (!DRIFT_COMMANDS.has(actionCommand.name())) return;
    try {
      report(findAppRoot(process.cwd()));
    } catch {
      /* never fails the command */
    }
  });
}
