import {Command} from 'commander';
import {
  editDistance,
  suggestCommand,
  unknownCommandError,
} from '../../src/unknown-command.js';

/**
 * A program shaped like src/cli.ts: `build` is the default command and takes
 * two optional positionals plus `--silent`.
 */
const makeProgram = () => {
  const calls: {target?: string; target2?: string; silent?: boolean}[] = [];
  const program = new Command();
  program.exitOverride();
  program
    .command('build [target] [target2]', {isDefault: true})
    .option('--silent')
    .action((target, target2, options) => {
      calls.push({target, target2, silent: options?.silent});
    });
  program
    .command('build-all')
    .option('--sync')
    .action(() => {});
  program.command('build-app').action(() => {});
  program.command('app-doctor').action(() => {});
  program.command('register-local', {hidden: true}).action(() => {});
  program
    .command('package')
    .alias('pkg')
    .action(() => {});
  return {program, calls};
};

/** Mirrors src/cli.ts: guard first, then parse. */
const run = (args: string[]) => {
  const {program, calls} = makeProgram();
  const error = unknownCommandError(program, args);
  if (!error) {
    program.parse(args, {from: 'user'});
  }
  return {error, calls};
};

describe('unknown command', () => {
  test('an unknown word is rejected instead of reaching build', () => {
    const {error, calls} = run(['frobnicate']);
    expect(error).toBe(
      'Unknown command "frobnicate".\nRun "linked help" for the list.',
    );
    expect(calls).toEqual([]);
  });

  test('a typo suggests the closest command', () => {
    expect(run(['biuld']).error).toBe(
      'Unknown command "biuld".\nDid you mean "build"?\nRun "linked help" for the list.',
    );
    expect(run(['build-al']).error).toContain('Did you mean "build-all"?');
  });

  test('doctor points at its new name', () => {
    expect(run(['doctor']).error).toBe(
      'Unknown command "doctor".\nDid you mean "app-doctor"? ("doctor" was renamed)\nRun "linked help" for the list.',
    );
  });

  test('yarn says it was removed', () => {
    expect(run(['yarn']).error).toBe(
      'Unknown command "yarn".\n"yarn" was removed — use npm.\nRun "linked help" for the list.',
    );
  });

  test('hidden commands and aliases are known but never suggested', () => {
    expect(run(['register-local']).error).toBeUndefined();
    expect(run(['pkg']).error).toBeUndefined();
    expect(suggestCommand('register-locl', ['build'])).toBeUndefined();
  });

  test('help is known', () => {
    expect(
      unknownCommandError(makeProgram().program, ['help']),
    ).toBeUndefined();
  });
});

describe('build stays the default', () => {
  test('no command runs build', () => {
    expect(run([]).calls).toEqual([
      {target: undefined, target2: undefined, silent: undefined},
    ]);
  });

  test('an option alone runs build with that option', () => {
    expect(run(['--silent']).calls).toEqual([
      {target: undefined, target2: undefined, silent: true},
    ]);
  });

  test('explicit build keeps its target and options', () => {
    expect(run(['build', 'production', '--silent']).calls).toEqual([
      {target: 'production', target2: undefined, silent: true},
    ]);
  });
});

test('editDistance', () => {
  expect(editDistance('build', 'build')).toBe(0);
  expect(editDistance('biuld', 'build')).toBe(2);
  expect(editDistance('', 'abc')).toBe(3);
});
