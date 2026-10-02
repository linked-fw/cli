import type {Command} from 'commander';

/**
 * Commands that no longer exist under their old name. Checked before the
 * edit-distance suggestion so a rename points at its new name even when the
 * two words are far apart.
 */
const RENAMED: Record<string, string> = {
  doctor: 'app-doctor',
};

const REMOVED: Record<string, string> = {
  yarn: 'removed — use npm',
};

/** Classic Levenshtein distance. */
export const editDistance = (a: string, b: string): number => {
  const prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = above;
    }
  }
  return prev[b.length];
};

/** Every name (and alias) a command answers to, plus commander's implicit `help`. */
const commandNames = (program: Command, includeHidden: boolean): string[] => {
  const names = ['help'];
  for (const cmd of program.commands) {
    if (!includeHidden && (cmd as unknown as {_hidden?: boolean})._hidden) {
      continue;
    }
    names.push(cmd.name(), ...cmd.aliases());
  }
  return names;
};

/** The closest visible command name, or undefined when nothing is close. */
export const suggestCommand = (
  name: string,
  candidates: string[],
): string | undefined => {
  let best: string | undefined;
  let bestDistance = Infinity;
  const limit = name.length <= 3 ? 1 : Math.max(2, Math.floor(name.length / 3));
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    if (distance <= limit && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * `build` is the default command, so commander hands any word it does not
 * recognise to `build` as its target — `linked doctor` then fails with a
 * misleading build error. The default should only apply when no command is
 * given at all.
 *
 * Returns the error text for an unknown command in `args` (argv without the
 * node and script entries), or undefined when the args are fine to parse.
 */
export const unknownCommandError = (
  program: Command,
  args: string[],
): string | undefined => {
  const first = args[0];
  if (first === undefined || first.startsWith('-')) {
    return undefined;
  }
  if (commandNames(program, true).includes(first)) {
    return undefined;
  }
  const lines = [`Unknown command "${first}".`];
  if (RENAMED[first]) {
    lines.push(`Did you mean "${RENAMED[first]}"? ("${first}" was renamed)`);
  } else if (REMOVED[first]) {
    lines.push(`"${first}" was ${REMOVED[first]}.`);
  } else {
    const suggestion = suggestCommand(first, commandNames(program, false));
    if (suggestion) {
      lines.push(`Did you mean "${suggestion}"?`);
    }
  }
  lines.push('Run "linked help" for the list.');
  return lines.join('\n');
};
