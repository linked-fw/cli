// The `sh` that a git hook written by `linked localize` runs: it hands over to git-hook.cjs in the
// installed cli. src/localize/git-hooks.ts writes it into hook files; lock-at-rest.cjs prints it
// for a hook file that is not ours. One copy, so the two never drift apart.
// Plain, unbuilt CommonJS with Node built-ins only, like the other files in hooks/.
'use strict';

// What marks a hook file `linked localize` wrote.
const HOOK_MARKER = '# managed by linked localize';
// The script every hand-over runs, relative to the app: in our hook files and in the line a
// developer adds to their own.
const HOOK_SCRIPT = 'node_modules/@_linked/cli/hooks/git-hook.cjs';

/** `s` as one single-quoted `sh` word: survives spaces, `$`, quotes and backticks. */
function shQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The commands that run git-hook.cjs for `hook` from the app at `prefix` (relative to the git top
 * level, `/`-terminated or empty). Each is one `sh` command, so they can be lines of a file or
 * `; `-joined in a subshell.
 */
function hookCommands(hook, prefix) {
  const dir = prefix
    ? `dir="$(git rev-parse --show-toplevel)"/${shQuote(prefix.replace(/\/$/, ''))}`
    : 'dir="$(git rev-parse --show-toplevel)"';
  return [
    dir,
    `script="$dir/${HOOK_SCRIPT}"`,
    '{ [ -f "$script" ] && command -v node >/dev/null 2>&1; } || exit 0',
    // git starts a hook at the top level. With GIT_DIR set, git takes the
    // current directory for the top level unless GIT_WORK_TREE says otherwise,
    // and a relative path is relative to here: both stop holding after the cd.
    '[ -z "${GIT_DIR-}" ] || [ -n "${GIT_WORK_TREE-}" ] || export GIT_WORK_TREE="$PWD"',
    // Git for Windows' sh: an absolute path may also be `C:/...` or `C:\...`.
    'for v in GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE; do eval "p=\\${$v-}"; case "$p" in ""|/*|[A-Za-z]:*) ;; *) export "$v=$PWD/$p" ;; esac; done',
    'cd "$dir" || exit 0',
    `exec node "$script" ${hook} "$@"`,
  ];
}

/** The same hand-over as one line, in a subshell, for a hook file another tool or person owns. */
function hookLine(hook, prefix) {
  return `(${hookCommands(hook, prefix).join('; ')})`;
}

/** Does this hook file run ours: written by localize, or holding the line added by hand? */
function runsOurHook(text) {
  return text.includes(HOOK_MARKER) || text.includes(HOOK_SCRIPT);
}

module.exports = {HOOK_MARKER, HOOK_SCRIPT, hookCommands, hookLine, runsOurHook};
