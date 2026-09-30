import chalk from 'chalk';
import {execp} from '../utils.js';

/**
 * Run a yarn command at the workspace root, forwarding every argument to yarn.
 *
 * This used to back up the yarn.lock of each nested sibling repository before
 * running, because a multi-repo checkout tool dropped those repos under
 * `packages/` and a root-level `yarn install` clobbered their lockfiles. That
 * tool is retired and no such nested repos exist any more, so there is nothing
 * left to preserve — the command is now a thin, arg-preserving passthrough.
 *
 * Set LINKED_YARN_DRY_RUN to log the command instead of executing it.
 */
export async function safeYarn(args: string[]): Promise<void> {
  const yarnCmd = `yarn ${args.join(' ')}`;

  if (process.env.LINKED_YARN_DRY_RUN) {
    console.log(chalk.cyan(`[dry-run] would execute: ${yarnCmd}`));
    console.log(chalk.cyan(`[dry-run] received args: ${JSON.stringify(args)}`));
    return;
  }

  await execp(yarnCmd, true, false);
}
