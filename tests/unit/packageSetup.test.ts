import path from 'path';
import {planPackageSetup} from '../../src/utils/packageSetup.js';

const launch = '/opt/cli/lib/esm/launch.js';

describe('planPackageSetup (create-package install + build)', () => {
  test('npm is the default, even with yarn installed', () => {
    const plan = planPackageSetup('3.6.1\n', launch, '/usr/bin/node');
    expect(plan.packageManager).toBe('npm');
    expect(plan.installCommand).toBe('npm install');
    expect(plan.yarnrc).toBeNull();
  });

  test('Yarn Berry installs with the node-modules linker inside a yarn project', () => {
    const plan = planPackageSetup('3.6.1\n', launch, '/usr/bin/node', true);
    expect(plan.packageManager).toBe('yarn');
    expect(plan.installCommand).toBe('yarn install');
    expect(plan.yarnrc).toBe('nodeLinker: node-modules\n');
  });

  test('Yarn 1 needs no .yarnrc.yml', () => {
    const plan = planPackageSetup('1.22.22', launch, '/usr/bin/node', true);
    expect(plan.packageManager).toBe('yarn');
    expect(plan.yarnrc).toBeNull();
  });

  test('falls back to npm when yarn is unavailable', () => {
    const plan = planPackageSetup('', launch, '/usr/bin/node', true);
    expect(plan.packageManager).toBe('npm');
    expect(plan.installCommand).toBe('npm install');
    expect(plan.yarnrc).toBeNull();
  });

  test('builds through the running CLI, not npm exec', () => {
    const plan = planPackageSetup('3.6.1', launch, '/usr/bin/node', true);
    expect(plan.buildCommand).toBe(`"/usr/bin/node" "${path.resolve(launch)}" build`);
    expect(plan.buildCommand).not.toMatch(/npm exec|npx|lincd/);
  });

  test('quotes paths containing spaces', () => {
    const plan = planPackageSetup('', '/my dir/launch.js', '/node bin/node');
    expect(plan.buildCommand).toBe('"/node bin/node" "/my dir/launch.js" build');
  });
});
