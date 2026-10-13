import fs from 'fs';
import path from 'path';

// `build-all` exits 1 when a package fails, but only once the run has finished: commander
// awaits the action's promise only when the action returns it. A call without `return` lets
// the process move on before the summary and the exit code. Read from the source, since
// importing cli.ts parses the process's own argv.
describe('src/cli.ts calls buildAll', () => {
  test('every call returns its promise to commander', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/cli.ts'),
      'utf8',
    );
    const calls = source.match(/^.*\bbuildAll\(.*$/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const line of calls) expect(line.trim()).toMatch(/^return buildAll\(/);
  });
});
