import chalk from 'chalk';
import {exec, ExecOptions} from 'child_process';
import * as fs from 'fs';
import {builtinModules} from 'module';
import * as path from 'path';
import ts from 'typescript';
import type {PackageDetails} from './interfaces.js';

import * as crypto from 'crypto';
import {findNearestPackageJsonSync} from 'find-nearest-package-json';
import * as glob from 'glob';

var gruntConfig;

// Credit: https://gist.github.com/tinovyatkin/727ddbf7e7e10831a1eca9e4ff2fc32e
const tsHost = ts.createCompilerHost(
  {
    allowJs: true,
    noEmit: true,
    isolatedModules: true,
    resolveJsonModule: false,
    moduleResolution: ts.ModuleResolutionKind.Classic, // we don't want node_modules
    incremental: true,
    noLib: true,
    noResolve: true,
  },
  true,
);

export var getFileImports = async function (filePath) {
  try {
    const importing: string[] = [];

    const add = (literal: ts.Node) => {
      const moduleName = literal.getText().replace(/['"`]/g, '');
      if (
        !moduleName.startsWith('node:') &&
        !builtinModules.includes(moduleName)
      ) {
        importing.push(moduleName);
      }
    };
    // Every form that names a module: `import ... from 'x'`, `import 'x'`,
    // `export ... from 'x'`, `import('x')` (value and type position) and
    // `import x = require('x')`. Children are always visited, so specifiers
    // nested inside functions or a `declare module` body are found too.
    const delintNode = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        // `import('x')` with a literal argument. A computed specifier cannot be
        // checked statically and is skipped.
        add(node.arguments[0]);
      } else if (
        // `type A = import('x').B`, and the same inside `typeof import('x')`.
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        add(node.argument.literal);
      } else if (
        // `import x = require('x')`.
        ts.isExternalModuleReference(node) &&
        ts.isStringLiteralLike(node.expression)
      ) {
        add(node.expression);
      }
      ts.forEachChild(node, delintNode);
    };
    const sourceFile = tsHost.getSourceFile(
      filePath,
      ts.ScriptTarget.Latest,
      (msg) => {
        throw new Error(`Failed to parse ${filePath}: ${msg}`);
      },
    );
    //check if its a directory, then we wanr that we can't parse it
    let stat = fs.lstatSync(filePath);
    if (stat.isDirectory()) {
      return importing;
    }

    if (!sourceFile) {
      console.warn(`Failed to find file ${filePath}`);
      return importing;
    }
    delintNode(sourceFile);
    return importing;
  } catch (err) {
    console.warn(`Error parsing file ${filePath}: ${err}`);
    return [];
  }
};

// The package name part of a bare specifier: '@scope/name' for a scoped
// package, the first segment otherwise. Returns null for anything that is not a
// bare specifier (relative and absolute paths). The 'node:' case is redundant
// for callers that use getFileImports (which drops builtins already), and is
// kept so the helper is correct standalone.
var barePackageName = function (importPath: string): string | null {
  if (
    importPath.startsWith('.') ||
    importPath.startsWith('/') ||
    importPath.startsWith('node:')
  ) {
    return null;
  }
  const segments = importPath.split('/');
  const name = importPath.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
  return name || null;
};

var isLinkedPackageName = function (name: string) {
  // The current '@_linked/*' scope, and the legacy 'lincd'-prefixed names
  // ('lincd', 'lincd-foo', ...).
  return name.startsWith('@_linked/') || /^lincd(-|$)/.test(name);
};

/**
 * True when the import reaches into ANOTHER Linked package's internals — a
 * '/src/' or '/lib/' path inside '@_linked/<pkg>' or a 'lincd'-prefixed package
 * — instead of going through that package's public subpath. Such an import
 * breaks when the other package changes its build layout, and it bypasses the
 * exports map, so the two are not interchangeable.
 *
 * Relative specifiers are exempt on purpose: the rule is about other packages,
 * and a relative path can only reach files inside the current package, where a
 * './lib/helpers' folder is a perfectly ordinary local module. Escaping the
 * package with '../' is already caught by isImportOutsideOfPackage.
 *
 * @param importPath The import path to check
 */
export var isInternalLinkedImport = function (importPath: string) {
  const name = barePackageName(importPath);
  if (!name || !isLinkedPackageName(name)) {
    return false;
  }
  // Match whole path segments, so '@_linked/core/library/x' is not a hit.
  const subPath = importPath.slice(name.length).split('/').filter(Boolean);
  return subPath.includes('src') || subPath.includes('lib');
};
/**
 * True when a relative import escapes the package source root. Normalising
 * first is what makes this correct: only leading '..' segments that survive
 * normalisation actually climb out, so './a..b' is an ordinary file name and
 * '../a/../b' climbs one level, not two.
 *
 * @param importPath The import path to check
 * @param curFileDepth How many folders deep the current file is (0 = src, 1 = src/foo, etc.)
 */
export var isImportOutsideOfPackage = function (
  importPath: string,
  curFileDepth: number,
) {
  if (!importPath.startsWith('.')) {
    return false;
  }
  const segments = path.posix
    .normalize(importPath.split('\\').join('/'))
    .split('/');
  // How many folders the specifier climbs: the leading '..' segments that
  // normalisation could not cancel out.
  let climbs = 0;
  while (segments[climbs] === '..') {
    climbs++;
  }
  return climbs > curFileDepth;
};

export var getPackageJSON = function (root = process.cwd(), error = true) {
  // console.log('Getting package.json from ' + chalk.cyan(root));
  //log stack trace
  let packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } else if (root === process.cwd()) {
    if (error) {
      console.warn(
        'Could not find package.json. Make sure you run this command from the root of a linked package or a linked workspace',
      );
      process.exit();
    }
  }
};

/**
 * Scans package.json for dependencies that are LINCD packages
 * Also looks into dependencies of dependencies
 * If no packageJson is given, it will attempt to obtain it from the current working directory
 * Returns an array of lincd packages, with each entry containing an array with the package name and the local path to the package
 * @param packageJson
 */
export var getLINCDDependencies = function (
  packageJson?,
  checkedPackages: Set<string> = new Set(),
): [string, string, string[]][] {
  if (!packageJson) {
    packageJson = getPackageJSON();
  }
  let dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  let lincdPackagePaths: [string, string, string[]][] = [];
  let firstTime = checkedPackages.size === 0;

  for (var dependency of Object.keys(dependencies)) {
    try {
      if (!checkedPackages.has(dependency)) {
        let [modulePackageJson, modulePath] = getModulePackageJSON(dependency);
        checkedPackages.add(dependency);

        if (modulePackageJson?.lincd) {
          lincdPackagePaths.push([
            modulePackageJson.name,
            modulePath,
            [
              ...Object.keys({
                ...modulePackageJson.dependencies,
                ...modulePackageJson.devDependencies,
              }),
            ],
          ]);
          //also check if this package has any dependencies that are lincd packages
          lincdPackagePaths = lincdPackagePaths.concat(
            getLINCDDependencies(modulePackageJson, checkedPackages),
          );
        }
        if (!modulePackageJson) {
          //this seems to only happen with yarn workspaces for some grunt related dependencies of lincd-cli
          // console.log(`could not find package.json of ${dependency}`);
        }
      }
    } catch (err) {
      console.log(
        `could not check if ${dependency} is a lincd package: ${err}`,
      );
    }
  }

  if (firstTime) {
    // let dependencyMap:Map<string,Set<string>> = new Map();
    let lincdPackageNames = new Set(
      lincdPackagePaths.map(
        ([packageName, modulePath, pkgDependencies]) => packageName,
      ),
    );
    //remove lincd-cli from the list of lincd packages
    lincdPackageNames.delete('lincd-cli');

    lincdPackagePaths.forEach(
      ([packageName, modulePath, pkgDependencies], key) => {
        let lincdDependencies = pkgDependencies.filter((dependency) =>
          lincdPackageNames.has(dependency),
        );
        if (packageName === 'lincd-cli') {
          //remove lincd-modules from the dependencies of lincd-cli (it's not a hard dependency, and it messes things up)
          lincdDependencies.splice(
            lincdDependencies.indexOf('lincd-modules'),
            1,
          );
        }
        // dependencyMap.set(packageName, new Set(lincdDependencies));
        //update dependencies to be the actual lincd package objects
        lincdPackagePaths[key][2] = lincdDependencies;
      },
    );

    // //add the nested dependencies for each lincd package
    // for (let [packageName,pkgDependencies] of dependencyMap) {
    //   pkgDependencies.forEach((dependency) => {
    //     if (dependencyMap.has(dependency)) {
    //       dependencyMap.get(dependency).forEach((nestedDependency) => {
    //         pkgDependencies.add(nestedDependency);
    //       });
    //     }
    //   });
    // }
    //
    // dependencyMap.forEach((dependencies,packageName) => {
    //   //check for circular dependencies
    //   if([...dependencies].some(dependency => {
    //     return dependencyMap.get(dependency).has(packageName);
    //   }))
    //   {
    //     console.warn(`Circular dependency detected between ${packageName} and ${dependency}`);
    //   }
    //
    // });

    // a simple sort with dependencyMap doesn't seem to work,so we start with LINCD (least dependencies) and from there add packages that have all their dependencies already added
    let sortedPackagePaths = [];
    let addedPackages = new Set();
    let lincdItself = lincdPackagePaths.find(([packageName]) => {
      return packageName === 'lincd';
    });
    if (lincdItself) {
      sortedPackagePaths.push(lincdItself);
      addedPackages = new Set(['lincd']);
    }

    while (addedPackages.size !== lincdPackagePaths.length) {
      let startSize = addedPackages.size;
      lincdPackagePaths.forEach(
        ([packageName, modulePath, pkgDependencies]) => {
          if (
            !addedPackages.has(packageName) &&
            pkgDependencies.every((dependency) => addedPackages.has(dependency))
          ) {
            sortedPackagePaths.push([packageName, modulePath, pkgDependencies]);
            addedPackages.add(packageName);
          }
        },
      );
      if (startSize === addedPackages.size) {
        console.warn('Could not sort lincd packages, circular dependencies?');
        break;
      }
    }

    //sort the lincd packages by least dependent first
    // lincdPackagePaths = lincdPackagePaths.sort(([packageNameA],[packageNameB]) => {
    //   //if package A depends on package B, then package B should come first
    //   if (dependencyMap.get(packageNameA).has(packageNameB)) {
    //     console.log(packageNameA+' depends on '+packageNameB+ ' (below)')
    //       return 1;
    //   }
    //   console.log(packageNameA+' above '+packageNameB)
    //   return -1;
    // });
    return sortedPackagePaths;
  }

  return lincdPackagePaths;
};

export const getLastBuildTime = (packagePath) => {
  return getLastModifiedFile(packagePath + '/@(builds|lib|dist)/**/*.js');
};

export const getLastModifiedSourceTime = (packagePath) => {
  return getLastModifiedFile(packagePath + '/@(src|data|css|modules)/**/*', {
    ignore: [
      packagePath + '/**/*.css.json',
      packagePath + '/**/*.d.ts',
      packagePath + '/**/node_modules/**/*',
      packagePath + '/**/lib/**/*',
      packagePath + '/**/dist/**/*',
    ],
  });
};

export const getLastCommitTime = (
  packagePath,
): Promise<{date: Date; changes: string; commitId: string}> => {
  // console.log(`git log -1 --format=%ci -- ${packagePath}`);
  // process.exit();
  return execPromise(`cd ${packagePath} && git log -1 --format="%h %ci" -- .`)
    .then(async (result) => {
      let commitId = result.substring(0, result.indexOf(' '));
      let date = result.substring(commitId.length + 1);
      let lastCommitDate = new Date(date);

      let changes = await execPromise(
        `cd ${packagePath} && git show --stat --oneline ${commitId} -- .`,
      );
      // log(packagePath, result, lastCommitDate);
      // log(changes);
      return {date: lastCommitDate, changes, commitId};
    })
    .catch(({error, stdout, stderr}) => {
      debugInfo(chalk.red('Git error: ') + error.message.toString());
      return null;
    });
};

export const getLastModifiedFile = (filePath, config = {}) => {
  var files = glob.sync(filePath, config);

  // console.log(files.join(" - "));
  var lastModifiedName;
  var lastModified: Date;
  var lastModifiedTime = 0;
  files.forEach((fileName) => {
    if (fs.lstatSync(fileName).isDirectory()) {
      // console.log("skipping directory "+fileName);
      return;
    }
    let mtime = fs.statSync(path.join(fileName)).mtime;
    let modifiedTime = mtime.getTime();
    if (modifiedTime > lastModifiedTime) {
      // console.log(fileName,mtime);
      lastModifiedName = fileName;
      lastModified = mtime;
      lastModifiedTime = modifiedTime;
    }
  });
  return {lastModified, lastModifiedName, lastModifiedTime};
};

//from https://github.com/haalcala/node-packagejson/blob/master/index.js
export var getModulePackageJSON = function (module_name, work_dir?) {
  if (!work_dir) {
    work_dir = process.cwd();
  } else {
    work_dir = path.resolve(work_dir);
  }

  var package_json;

  if (fs.existsSync(path.resolve(work_dir, './node_modules'))) {
    var module_dir = path.resolve(work_dir, './node_modules/' + module_name);

    if (
      fs.existsSync(module_dir) &&
      fs.existsSync(module_dir + '/package.json')
    ) {
      package_json = JSON.parse(
        fs.readFileSync(module_dir + '/package.json', 'utf-8'),
      );
    }
  }

  if (!package_json && work_dir != '/') {
    return getModulePackageJSON(module_name, path.resolve(work_dir, '..'));
  }

  return [package_json, module_dir];
};
export function execp(
  cmd,
  log: boolean = false,
  allowError: boolean = false,
  options: any = {},
): Promise<null> {
  // opts || (opts = {});
  if (log) console.log(chalk.cyan(cmd));

  return new Promise((resolve, reject) => {
    var child = exec(cmd, options);

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    // process.stdin.pipe(child.stdin);

    child.on('close', function (code) {
      if (code === 0) {
        resolve(null);
      } else {
        reject();
      }
      // console.log('killing child');
      // child.kill('SIGHUP');
      // resolve(code);
    });
    // child.on('data', function (result) {
    // 	// if (log)
    // 	// {
    // 	// 	console.log(result);
    // 	// }
    // 	resolve(result);
    // 	console.log('resolve data');
    //
    // });

    child.on('error', function (err) {
      if (!allowError) {
        // console.log('reject err');
        reject(err);
        return;
      } else if (log) {
        console.warn(err);
      }
      // console.log('resolve err');
      resolve(null);
    });
    child.on('exit', function (code, signal) {
      if (code !== 0) {
        reject('Child process exited with error code ' + code);
        return;
      }
      // console.log('resolve exit');
      resolve(null);
    });
  });
}

export function execPromise(
  command,
  log = false,
  allowError: boolean = false,
  options?: ExecOptions,
  pipeOutput: boolean = false,
): Promise<string> {
  return new Promise(function (resolve, reject) {
    if (log) console.log(chalk.cyan(command));
    let child = exec(command, options, (error, stdout, stderr) => {
      if (error) {
        if (!allowError) {
          reject({error, stdout, stderr});
          return;
        } else if (log) {
          console.warn(error);
        }
      }
      //TODO: getting a typescript error for 'trim()', this worked before, is it still used? do we log anywhere?
      let result = stdout['trim']();
      if (log) {
        // console.log(chalk"RESOLVING "+command);
        console.log(result);
        // console.log('ERRORS:'+(result.indexOf('Aborted due to warnings') !== -1));
        // console.log('stderr:'+stderr);
      }
      resolve(result);
    });
    if (pipeOutput) {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
  });
}

export function generateScopedNameProduction(cssClassName, filepath, css?) {
  //for app development we can use short unique hashes
  //but for webpack bundles of lincd modules, we need to ensure unique class names across bundles of many packages
  //generate a short unique hash based on cssClassName and filepath
  let hash = crypto
    .createHash('md5')
    .update(cssClassName + filepath)
    .digest('hex')
    .substring(0, 6);
  return hash;
}
export function generateScopedName(cssClassName, filepath, css?) {
  // Strip any Vite-style query suffix (?inline, ?raw, ?direct) before
  // computing the filename. Without this, dev-mode SSR CSS collection
  // via `?inline` produces selectors like
  // `._foo_SigninLayout.module.css?inline_leftSidebar` — the literal
  // `.module.css?inline` becomes part of the class name, which CSS
  // parsers split on `.` and `?`, breaking everything.
  const cleanFilepath = filepath.replace(/\?.*$/, '');
  var filename = path
    .basename(cleanFilepath)
    .replace(/\.module\.css$/, '')
    .replace(/\.css$/, '');
  let resolved = path.resolve(cleanFilepath).replace(/[\w\-_\/]+\/file\:/, '');
  let nearestPackageJson = findNearestPackageJsonSync(resolved);
  let packageName = nearestPackageJson
    ? nearestPackageJson.data.name
    : 'unknown';
  return (
    packageName.replace(/[^a-zA-Z0-9_]+/g, '_') +
    '_' +
    filename +
    '_' +
    cssClassName
  );
}

export const needsRebuilding = async function (
  pkg: PackageDetails,
  useGitForLastModified: boolean,
  log: boolean = false,
) {
  let lastModifiedSourceDate: Date;
  let lastModifiedSourceName: string;

  if (useGitForLastModified) {
    const {changes, commitId, date} = await getLastCommitTime(pkg.path);

    lastModifiedSourceDate = date;
    lastModifiedSourceName = commitId;
  } else {
    const {lastModified, lastModifiedName, lastModifiedTime} =
      getLastModifiedSourceTime(pkg.path);
    lastModifiedSourceName = lastModifiedName;
    lastModifiedSourceDate = lastModified;
  }

  let lastModifiedBundle = getLastBuildTime(pkg.path);
  let result =
    lastModifiedSourceDate &&
    lastModifiedSourceDate.getTime() > lastModifiedBundle.lastModifiedTime;
  if (log) {
    console.log(
      chalk.cyan(
        'Last modified source: ' +
          lastModifiedSourceName +
          ' on ' +
          lastModifiedSourceDate.toString(),
      ),
    );
    console.log(
      chalk.cyan(
        'Last build: ' +
          (lastModifiedBundle &&
          typeof lastModifiedBundle.lastModified !== 'undefined'
            ? lastModifiedBundle.lastModified.toString()
            : 'never'),
      ),
    );
  }
  return result;
};

export function log(...messages) {
  messages.forEach((message) => {
    console.log(chalk.cyan(message));
  });
}

export function debug(config, ...messages) {
  if (config.debug) {
    log(...messages);
  }
}

export function debugInfo(...messages) {
  // messages.forEach((message) => {
  //   console.log(chalk.cyan('Info: ') + message);
  // });
  //@TODO: let packages also use linked.config.json? instead of gruntfile...
  // that way we can read "analyse" here and see if we need to log debug info
  // if(!gruntConfig)
  // {
  //   gruntConfig = getGruntConfig();
  //   console.log(gruntConfig);
  //   process.exit();
  // }
  if (gruntConfig && gruntConfig.analyse === true) {
    messages.forEach((message) => {
      console.log(chalk.cyan('Info: ') + message);
    });
  }
}

export function warn(...messages) {
  messages.forEach((message) => {
    console.log(chalk.red(message));
  });
}

export function flatten(arr) {
  return arr.reduce(function (a, b) {
    return b ? a.concat(b) : a;
  }, []);
}

export function getLinkedTailwindColors() {
  return {
    'primary-color': 'var(--primary-color)',
    'font-color': 'var(--font-color)',
  };
}

/**
 * Recursively get all files in a directory
 * https://stackoverflow.com/a/45130990/831465
 * @param dir The directory to get files from
 * @returns A promise that resolves to an array of file paths
 */
export async function getFiles(
  dir: string,
  filenameFilter?: string,
): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true});
  let files = await Promise.all(
    entries.map((entry) => {
      const res = path.resolve(dir, entry.name);
      return entry.isDirectory() ? getFiles(res, filenameFilter) : res;
    }),
  );
  //flatten the array of arrays into a single array
  let flatFiles = flatten(files) as string[];
  if (filenameFilter) {
    //filter the files to only include those that match the filenameFilter
    flatFiles = flatFiles.filter((file) => file.includes(filenameFilter));
  }
  return flatFiles;
}

/**
 * Strip ANSI escape codes from a string
 * @param str The string to strip ANSI codes from
 * @returns The string with ANSI codes removed
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
