import {excerptBuildError} from '../../src/build-error-excerpt';

// The end-of-run summary of `build-all` shows a short excerpt of each failed
// build's output, because the full output was printed inline, interleaved
// with the other parallel builds. These pin which lines make the excerpt.

const lines = (...l: string[]) => l.join('\n');

describe('excerptBuildError', () => {
  it('picks the thrown error and its first stack frame out of npm noise', () => {
    const output = lines(
      'npm notice run @_linked/xsd@1.2.5 build',
      'npm notice run linked build',
      '',
      'node:internal/modules/run_main:123',
      '    triggerUncaughtException(',
      '    ^',
      "Error: ENOENT: no such file or directory, open '/x/_linked-cli/lib/esm/installed-packages.js'",
      '    at Object.openSync (node:fs:560:18)',
      '    at Object.readFileSync (node:fs:441:35)',
      '    at file:///x/_linked-cli/lib/esm/cli.js:10:5',
      '',
      'Node.js v24.1.0',
    );
    expect(excerptBuildError(output)).toEqual([
      "Error: ENOENT: no such file or directory, open '/x/_linked-cli/lib/esm/installed-packages.js'",
      '    at Object.openSync (node:fs:560:18)',
    ]);
  });

  it('shows TypeScript errors with their file and line', () => {
    const output = lines(
      '> @probe/a@1.0.0 build',
      '> tsc -p tsconfig.json',
      '',
      "src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/other.ts:12:5 - error TS2304: Cannot find name 'foo'.",
      '',
      '12     foo();',
      '       ~~~',
      '',
      'Found 2 errors in 2 files.',
      'npm error code 2',
      'npm error path /x/packages/a',
      'npm error command failed',
      'npm error command sh -c tsc -p tsconfig.json',
      'npm error A complete log of this run can be found in: /x/.npm/_logs/a.log',
    );
    expect(excerptBuildError(output)).toEqual([
      "src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/other.ts:12:5 - error TS2304: Cannot find name 'foo'.",
    ]);
  });

  it('keeps npm errors that say something, drops npm lifecycle boilerplate', () => {
    const output = lines(
      'npm ERR! Missing script: "build"',
      'npm ERR! code ELIFECYCLE',
      'npm ERR! errno 1',
      'npm ERR! A complete log of this run can be found in: /x.log',
    );
    expect(excerptBuildError(output)).toEqual(['npm ERR! Missing script: "build"']);
  });

  it('de-duplicates repeated lines', () => {
    const output = lines(
      'Error: boom',
      '    at a (x.js:1:1)',
      'Error: boom',
      '    at a (x.js:1:1)',
    );
    expect(excerptBuildError(output)).toEqual(['Error: boom', '    at a (x.js:1:1)']);
  });

  it('caps the number of lines and says how many more there were', () => {
    const output = Array.from(
      {length: 20},
      (_, i) => `src/f${i}.ts(1,1): error TS1005: ';' expected.`,
    ).join('\n');
    const excerpt = excerptBuildError(output, 6);
    expect(excerpt).toHaveLength(6);
    expect(excerpt[0]).toBe("src/f0.ts(1,1): error TS1005: ';' expected.");
    expect(excerpt[5]).toBe('… 15 more');
  });

  it('truncates long lines', () => {
    const excerpt = excerptBuildError('Error: ' + 'x'.repeat(500), 8, 80);
    expect(excerpt[0]).toHaveLength(80);
    expect(excerpt[0].endsWith('…')).toBe(true);
  });

  it('strips terminal colours', () => {
    expect(excerptBuildError('\u001b[31mError: red\u001b[39m')).toEqual([
      'Error: red',
    ]);
  });

  it('falls back to the last meaningful lines when nothing looks like an error', () => {
    const output = lines(
      'npm notice run build',
      'step 1',
      'step 2',
      'step 3',
      'step 4',
      'it went wrong somehow',
      '',
      'npm error code 1',
    );
    expect(excerptBuildError(output, 3)).toEqual([
      'step 3',
      'step 4',
      'it went wrong somehow',
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(excerptBuildError('')).toEqual([]);
    expect(excerptBuildError(lines('npm notice run build', '', '   '))).toEqual(
      [],
    );
  });
});
