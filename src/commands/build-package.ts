import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import {execp} from '../utils.js';
import {detectPackageManager} from '../utils/packageManager.js';

/**
 * Given any file or directory path, walk up to find the nearest package.json
 * and run `linked build` in that package's directory. This is the editor-hook
 * variant of build: the caller knows a file path, we figure out the package.
 *
 * Only rebuilds packages flagged `linkedPackage: true` (or legacy `lincd: true`).
 */
export async function buildPackageByPath(filePath: string): Promise<void> {
  let currentPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (fs.existsSync(currentPath) && fs.statSync(currentPath).isFile()) {
    currentPath = path.dirname(currentPath);
  }

  while (currentPath !== path.dirname(currentPath)) {
    const pkgJsonPath = path.join(currentPath, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const isLinked = pkgJson.linkedPackage === true || pkgJson.lincd === true;

      if (!isLinked) {
        console.log(
          chalk.yellow(
            `Package ${pkgJson.name} is not a linked package (no linkedPackage flag). Skipping.`,
          ),
        );
        return;
      }

      console.log(chalk.cyan(`Rebuilding ${pkgJson.name}`));

      // npm is the default. Only a package that actually lives in a yarn
      // project is built through yarn — that keeps existing yarn monorepos
      // (which may vendor their own yarn release) working.
      //
      // Either way we invoke the `linked` BINARY rather than a script: inner
      // packages don't have a "linked" script in package.json.
      let runner = 'npx --no-install';
      if (detectPackageManager(currentPath) === 'yarn') {
        let yarnBin = 'yarn';
        const yarnReleasesDir = path.join(process.cwd(), '.yarn', 'releases');
        if (fs.existsSync(yarnReleasesDir)) {
          const releases = fs.readdirSync(yarnReleasesDir);
          if (releases.length > 0) {
            yarnBin = path.join(yarnReleasesDir, releases[0]);
          }
        }
        runner = `${yarnBin} exec`;
      }

      const command = `cd ${currentPath} && ${runner} linked build`;
      await execp(command, true, false);
      return;
    }
    currentPath = path.dirname(currentPath);
  }

  console.error(chalk.red(`No package.json found walking up from ${filePath}`));
  process.exit(1);
}
