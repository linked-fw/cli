/**
 * The clone hint `worktree add --dataset` and `branch start --worktree
 * --dataset` print: the app's `clone-dataset` npm script, or the one its linked
 * config names with `datasetCloneScript`; a warning when the script is missing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appPort,
  datasetCloneHint,
  datasetCloneMessages,
  readDatasetCloneScript,
} from '../../src/commands/worktree.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clone-hint-')));
});
afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

const writePkg = (scripts: Record<string, string>) =>
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'app', scripts}));

describe('datasetCloneHint', () => {
  test('script found: prints the npm run command with the dataset', () => {
    writePkg({'clone-dataset': 'scripts/clone.sh'});
    expect(datasetCloneHint(root, 'wt-a1')).toEqual([
      `Clone the data into wt-a1 first (from ${root}): npm run clone-dataset -- wt-a1`,
    ]);
  });

  test('shell-quotes the dataset', () => {
    writePkg({'clone-dataset': 'x'});
    expect(datasetCloneHint(root, "a b'c")[0]).toMatch(/npm run clone-dataset -- 'a b'\\''c'$/);
  });

  test('config override: names the configured script', () => {
    writePkg({'clone-dataset': 'x', 'data:clone': 'y'});
    expect(datasetCloneHint(root, 'wt-a1', 'data:clone')).toEqual([
      `Clone the data into wt-a1 first (from ${root}): npm run data:clone -- wt-a1`,
    ]);
  });

  test('override naming a missing script: warns, even when clone-dataset exists', () => {
    writePkg({'clone-dataset': 'x'});
    const lines = datasetCloneHint(root, 'wt-a1', 'data:clone');
    expect(lines[0]).toMatch(/^Warning: datasetCloneScript in the linked config names "data:clone", but .*package\.json has no such script, so wt-a1 starts empty/);
    expect(lines.join('\n')).not.toMatch(/npm run clone-dataset/);
    expect(lines[1]).toContain('npm run data:clone -- wt-a1');
  });

  test('no script: warns that the dataset starts empty and how to add one', () => {
    writePkg({start: 'linked start'});
    const lines = datasetCloneHint(root, 'wt-a1');
    expect(lines[0]).toBe('Warning: the app has no clone-dataset script, so wt-a1 starts empty unless it is cloned by hand.');
    expect(lines[1]).toContain('add a "clone-dataset" script');
    expect(lines[1]).toContain('datasetCloneScript in the linked config');
  });

  test('no package.json: warns', () => {
    expect(datasetCloneHint(root, 'wt-a1')[0]).toMatch(/^Warning: the app has no clone-dataset script/);
  });
});

describe('readDatasetCloneScript', () => {
  test('reads datasetCloneScript from linked.config.js', async () => {
    fs.writeFileSync(path.join(root, 'linked.config.js'), "export default {datasetCloneScript: 'data:clone'};");
    expect(await readDatasetCloneScript(root)).toBe('data:clone');
  });

  test('undefined without a config, or when the config does not set it', async () => {
    expect(await readDatasetCloneScript(root)).toBeUndefined();
    fs.writeFileSync(path.join(root, 'linked.config.js'), 'export default {cssMode: "tailwind"};');
    expect(await readDatasetCloneScript(root)).toBeUndefined();
  });

  test('a config that fails to load falls back to the default script', async () => {
    writePkg({'clone-dataset': 'x'});
    fs.writeFileSync(path.join(root, 'linked.config.js'), "throw new Error('boom');");
    expect(await datasetCloneMessages(root, 'wt-a1')).toEqual([
      `Clone the data into wt-a1 first (from ${root}): npm run clone-dataset -- wt-a1`,
    ]);
  });

  test('datasetCloneMessages uses the configured script', async () => {
    writePkg({'data:clone': 'y'});
    fs.writeFileSync(path.join(root, 'linked.config.js'), "export default {datasetCloneScript: 'data:clone'};");
    expect(await datasetCloneMessages(root, 'wt-a1')).toEqual([
      `Clone the data into wt-a1 first (from ${root}): npm run data:clone -- wt-a1`,
    ]);
  });
});

describe('appPort', () => {
  test("the .env's PORT, else the default 4040", () => {
    expect(appPort(root)).toBe(4040);
    fs.writeFileSync(path.join(root, '.env'), 'FOO=1\nPORT=4100\n');
    expect(appPort(root)).toBe(4100);
  });
});
