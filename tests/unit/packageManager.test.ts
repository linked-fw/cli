// npm is the CLI's default package manager. yarn is only used when the tree
// itself says it is a yarn project — that keeps existing yarn monorepos
// (create_now pins yarn 3.6.1) working without assuming yarn anywhere else.
import path from 'path';
import {
  detectPackageManager,
  execBinCommand,
  runScriptCommand,
} from '../../src/utils/packageManager.js';

/** Builds an `exists` predicate from a list of absolute paths. */
const existsIn = (paths: string[]) => (p: string) => paths.includes(p);

const root = path.resolve('/repo');
const pkg = path.join(root, 'packages', 'thing');

describe('detectPackageManager', () => {
  test('defaults to npm when nothing marks the tree', () => {
    expect(detectPackageManager(pkg, existsIn([]))).toBe('npm');
  });

  test('npm when a package-lock.json sits in the package', () => {
    expect(
      detectPackageManager(pkg, existsIn([path.join(pkg, 'package-lock.json')])),
    ).toBe('npm');
  });

  test('yarn when the package has a yarn.lock', () => {
    expect(
      detectPackageManager(pkg, existsIn([path.join(pkg, 'yarn.lock')])),
    ).toBe('yarn');
  });

  test('yarn when an ancestor workspace is a yarn project', () => {
    expect(
      detectPackageManager(pkg, existsIn([path.join(root, 'yarn.lock')])),
    ).toBe('yarn');
  });

  test('yarn for a .yarnrc.yml-only Berry workspace', () => {
    expect(
      detectPackageManager(pkg, existsIn([path.join(root, '.yarnrc.yml')])),
    ).toBe('yarn');
  });

  test('yarn for a workspace that vendors its own yarn release', () => {
    expect(
      detectPackageManager(
        pkg,
        existsIn([path.join(root, '.yarn', 'releases')]),
      ),
    ).toBe('yarn');
  });

  test('the nearest marker wins: npm package inside a yarn workspace', () => {
    expect(
      detectPackageManager(
        pkg,
        existsIn([
          path.join(pkg, 'package-lock.json'),
          path.join(root, 'yarn.lock'),
        ]),
      ),
    ).toBe('npm');
  });

  test('terminates at the filesystem root', () => {
    expect(detectPackageManager(path.resolve('/'), existsIn([]))).toBe('npm');
  });
});

describe('command builders', () => {
  test('npm runs scripts through `npm run`', () => {
    expect(runScriptCommand('npm', 'build')).toBe('npm run build');
  });

  test('yarn runs scripts directly', () => {
    expect(runScriptCommand('yarn', 'build')).toBe('yarn build');
  });

  test('npm execs local bins through npx without installing', () => {
    expect(execBinCommand('npm', 'tsc')).toBe('npx --no-install tsc');
  });

  test('yarn execs local bins through `yarn exec`', () => {
    expect(execBinCommand('yarn', 'tsc')).toBe('yarn exec tsc');
  });
});
