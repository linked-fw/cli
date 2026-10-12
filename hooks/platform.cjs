// What the hooks do differently on Windows. Plain, unbuilt CommonJS with Node built-ins only, like
// the other files in hooks/; src/utils/spawn.ts is the cli's fuller version of npmCommand.
'use strict';

/**
 * How to run `npm <args>` on `platform`: on Windows npm is `npm.cmd`, a batch file Node refuses to
 * spawn without a shell (EINVAL since Node 18.20.2 / 20.12.2), so it goes through cmd.exe. The
 * arguments are fixed flags, with nothing cmd.exe would read specially.
 */
function npmCommand(args, platform = process.platform) {
  if (platform !== 'win32')
    return {command: 'npm', args: [...args], shell: false};
  if (args.some((a) => !/^[\w@./=:-]+$/.test(a)))
    throw new Error(
      `npmCommand: unsafe argument for cmd.exe: ${args.join(' ')}`,
    );
  return {command: ['npm.cmd', ...args].join(' '), args: [], shell: true};
}

/** The terminal to also write to, past npm's piping: none on Windows, which has no `/dev/tty`. */
function terminalDevice(platform = process.platform) {
  return platform === 'win32' ? null : '/dev/tty';
}

module.exports = {npmCommand, terminalDevice};
