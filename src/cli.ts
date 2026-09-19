#!/usr/bin/env tsx
//The line above calls the TSX typescript executer as runtime, which extends node.js and supports running typescript
// see: https://www.npmjs.com/package/tsx

// import babelRegister from '@babel/register';
// babelRegister({extensions: ['.ts', '.tsx']});

import chalk from 'chalk';
import {
  addCapacitor,
  buildAll,
  buildApp,
  buildPackage,
  buildUpdated,
  checkImports,
  compilePackage,
  createApp,
  createComponent,
  createOntology,
  createPackage,
  createSetComponent,
  createShape,
  depCheck,
  depCheckStaged,
  developPackage,
  executeCommandForEachPackage,
  executeCommandForPackage,
  getLincdPackages,
  getScriptDir,
  publishPackage,
  publishUpdated,
  register,
  runMethod,
  runScript,
  startServer,
  upgradePackages,
} from './cli-methods.js';
// import {buildMetadata} from './metadata';
import {program} from 'commander';
import fs from 'fs-extra';
import path from 'path';
import 'require-extensions';

/** `--env a,b` → `['a', 'b']`. */
const splitEnvOption = (value?: string): string[] =>
  (value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

program
  .command('create-app')
  .action((name, options) => {
    return createApp(name, process.cwd(), {
      appName: options.appName,
      appPrefix: options.appPrefix,
      appDomain: options.appDomain,
      skipInstall: options.skipInstall,
      template: options.template,
    }).catch((err) => {
      // Report and fail the process without cutting off pending output.
      console.error(chalk.red(err?.message ?? String(err)));
      process.exitCode = 1;
    });
  })
  .description(
    'Creates a new folder with all the required files for a Linked app',
  )
  .argument(
    '<name>',
    'the name of your Linked app. To use spaces, wrap the name in double quotes.',
  )
  .option('--app-name <name>', 'Display name for the app (skip interactive prompt)')
  .option('--app-prefix <prefix>', 'Short code prefix for data files (skip interactive prompt)')
  .option('--app-domain <domain>', 'Domain for the app (skip interactive prompt)')
  .option('--skip-install', 'Skip running npm install after scaffolding')
  .option(
    '--template <template>',
    'App template: "web" (default) or "react-native"',
  );

program
  .command('start')
  .action(async (options) => {
    // Vite is the default. The pre-Vite webpack dev server in
    // cli-methods startServer stays reachable through the deprecated
    // `--legacy` flag for projects that have not moved to Vite yet.
    if (options?.legacy) {
      return startServer();
    }
    const {startWithVite} = await import('./commands/start.js');
    return startWithVite({env: options?.env, apiOnly: options?.apiOnly});
  })
  .option('--env <env>', 'The node environment to use. Default is "development"')
  .option(
    '--api-only',
    'Serve only the backend API: no vite.config, src/App.tsx or src/routes.tsx needed; page requests get a 404',
  )
  .option('--legacy', 'Use the pre-Vite webpack dev server (deprecated; will be removed)')
  .description(
    'Start the Linked dev server. Vite-backed by default.',
  );

program
  .command('call')
  .action((packageName, method, options) => {
    return runMethod(packageName, method, {spawn: options.spawn});
  })
  .option(
    '--spawn',
    'Start a new server instance instead of using an existing one',
  )
  .option('--env', 'The node environment to use. Default is "development"')
  .description(
    'Start the Linked node.js server but without http server. Instead it immediately calls the specified method of the specified package and exits afterwards',
  )
  .argument(
    '<package>',
    'the package of the backend provider that contains this method',
  )
  .argument('<method>', 'the name of the method you want to call');

program
  .command('script')
  .action((scriptName, options) => {
    return runScript(scriptName, {spawn: options.spawn});
  })
  .option(
    '--spawn',
    'Start a new server instance instead of using an existing one',
  )
  .option('--env', 'The node environment to use. Default is "development"')
  .description(
    'Start the Linked node.js server but without http server. Instead it immediately runs the specified script and exits afterwards',
  )
  .argument(
    '<scriptName>',
    'the name of the script file inside the /scripts folder',
  );

program
  .command('create-package')
  .action((name, uriBase) => {
    return createPackage(name, uriBase);
  })
  .description(
    'Create a new folder with all the required files for a new Linked package',
  )
  .argument(
    '<name>',
    'The name of the package. Will be used as package name in package.json',
  )
  .argument(
    '[uri_base]',
    'The base URL used for data of this package. Leave blank to use the URL of your package on lincd.org after you register it',
  );

program
  .command('upgrade-packages')
  .action(() => {
    return upgradePackages();
  })
  .description(
    'Upgrade all linked packages in the workspace to ESM/CJS dual packages',
  );

program
  .command('create-shape')
  .action((name, uriBase) => {
    return createShape(name);
  })
  .description(
    'Creates a new ShapeClass file for your package. Execute this from your package folder.',
  )
  .argument(
    '<name>',
    'The name of the shape. Will be used for the file name and the class name',
  );

program
  .command('create-component')
  .action((name, uriBase) => {
    return createComponent(name);
  })
  .description(
    'Creates a new Component file for your package. Execute this from your package folder.',
  )
  .argument(
    '<name>',
    'The name of the component. Will be used for the file name and the export name',
  );

program
  .command('create-set-component')
  .action((name, uriBase) => {
    return createSetComponent(name);
  })
  .description(
    'Creates a new SetComponent file for your package. Execute this from your package folder.',
  )
  .argument(
    '<name>',
    'The name of the component. Will be used for the file name and the export name',
  );

program
  .command('create-ontology')
  .action((prefix, uriBase) => {
    return createOntology(prefix, uriBase);
  })
  .description(
    'Creates a new ontology file for your package. Execute this from your package folder.',
  )
  .argument(
    '<suggested-prefix>',
    'The suggested prefix for your ontology. Also the shorthand code used for the file name and the exported ontology object',
  )
  .argument(
    '[uribase]',
    "Optional argument to set the URI base for the URI's of all entities in your ontology. Leave blank to use the URI's provided by lincd.org once you register this package",
  );

program.command('app [action]', {hidden: true}).action(() => {
  register('http://localhost:4101');
});
program.command('register-local', {hidden: true}).action(() => {
  register('http://localhost:4101');
});
program.command('register-dev', {hidden: true}).action(() => {
  register('https://dev-registry.lincd.org');
});
program
  .command('register')
  .action(() => {
    register('https://registry.lincd.org');
  })
  .description(
    'Register (a new version of) this package to the Linked registry. If successful your package will appear on linked.cm',
  );

program
  .command('info')
  .action(() => {
    let localDir = getScriptDir();
    let packageJsonPath = path.join(localDir, 'package.json');
    try {
      var ownPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (e) {
      console.warn(
        'Could not read package.json at ' + packageJsonPath + ': ' + e,
      );
      process.exit();
    }
    console.log(ownPackage.version);
    console.log('Running from: ' + localDir);
  })
  .description(
    "Log the version of this tool and the path that it's running from",
  );

program
  .command('build [target] [target2]', {isDefault: true})
  .action(async (target, target2, options) => {
    const result = await buildPackage(target, target2, process.cwd(), !options?.silent);
    if (result !== true) {
      process.exitCode = 1;
    }
  })
  .option(
    '--silent',
    'No output to console unless errors occur. The exit code is unaffected: 0 when the build succeeds (warnings included), 1 when it fails',
  );

program
  .command('compile-only')
  .action(() => {
    compilePackage();
  })
  .description(
    'Compile the package without other build steps. Run this command from the package folder',
  );
program.command('build-metadata').action(() => {
  console.log('Needs to be reimplemented');
  // buildMetadata();
});
program
  .command('build-app')
  .action(async (options) => {
    // If vite.config.{ts,js,mjs} exists in cwd,
    // run `vite build` for the client bundle. Falls back to webpack
    // buildApp() when no Vite config (legacy apps).
    const {hasViteConfig, buildViteApp} = await import(
      './commands/build-app.js'
    );
    if (hasViteConfig()) {
      // Vite apps use the manifest-verified build and publishing flow.
      await buildViteApp({
        environmentNames: splitEnvOption(options?.env),
        target: options?.target,
        publish: options?.publish === true,
      });
      return;
    }
    // Older apps without Vite keep the existing Webpack build temporarily.
    return buildApp();
  })
  .option('--env <env>', 'The node environment to use. Default is "development"')
  .option('--target <target>', 'Build target: web or capacitor')
  .option(
    '--publish',
    'Upload the release after a successful web build (off by default; use `linked publish-app`)',
  )
  .description(
    'Build the linked app frontend and backend for production, and write a release manifest. Uses Vite for the frontend when vite.config exists; falls back to webpack.',
  );

program
  .command('publish-app')
  .option('--env <env>', 'The node environment to use')
  .option('--manifest <path>', 'Release manifest path')
  .option('--dry-run', 'Validate and print the release plan without uploading')
  .option('--yes', 'Upload the verified release')
  .action(async (options) => {
    // Retry or inspect an existing release without rebuilding the app.
    const {ensureEnvironmentLoaded} = await import('./lifecycle.js');
    const {resolveAppAssetsStore} = await import(
      './app-release/app-assets-store.js'
    );
    const {publishApp} = await import('./commands/publish-app.js');
    await ensureEnvironmentLoaded(splitEnvOption(options?.env));
    const store = await resolveAppAssetsStore();
    await publishApp({
      manifestPath: options?.manifest,
      store,
      yes: options?.yes === true && options?.dryRun !== true,
    });
  })
  .description(
    'Validate or retry publishing a previously built release. Defaults to dry run.',
  );

program
  .command('serve-app')
  .option('--env <env>', 'The node environment to use')
  .action(async (options) => {
    // Production runtime loads compiled output and never starts Vite/HMR.
    const {serveCompiledApp} = await import('./commands/serve-app.js');
    await serveCompiledApp({environmentNames: splitEnvOption(options?.env)});
  })
  .description('Start a compiled Linked app without Vite or HMR.');

program.command('publish-updated').action(() => {
  return publishUpdated();
});
program.command('publish [version]').action((version) => {
  publishPackage(null, false, null, version);
});

program.command('status').action(() => {
  //log which packages need to be published
  return publishUpdated(true).then(() => {
    //log which packages need to be build
    return buildUpdated(undefined, '', '', true);
  });
});
program
  .command('build-updated [target] [target2]')
  .action((target, target2, options) => {
    const {useGit}: {useGit?: boolean} = options;
    return buildUpdated(1, target, target2, useGit || false);
  })
  .option(
    '--use-git',
    'Use git commit timestamps to check which packages have been updated since the last build',
  );
program
  .command('build-updated-since [num-commits-back] [target] [target2]')
  .action((back, target, target2) => {
    return buildUpdated(back, target, target2);
  });
program
  .command('build-all')
  .action((options) => {
    buildAll(options);
  })
  .option(
    '--sync',
    'build each package 1 by 1 - use this if you have build issues due to low available RAM memory',
  )
  .option('--from <char>', 'start from a specific package');

program
  .command('build-workspace')
  .description(
    'Build all linked packages in the current workspace in dependency order',
  )
  .option('-u, --updated', 'Only build updated packages')
  .option(
    '--use-git',
    'Use git commit timestamps to determine which packages need updating',
  )
  .action(async (options) => {
    if (options.updated) {
      return buildUpdated(1, undefined, undefined, !!options.useGit);
    }
    return buildAll(options);
  });

program
  .command('build-package <filepath>')
  .description(
    'Given a file path, find its package.json and rebuild that package. Use for editor save hooks.',
  )
  .action(async (filepath) => {
    const {buildPackageByPath} = await import(
      './commands/build-package.js'
    );
    return buildPackageByPath(filepath);
  });

program
  .command('yarn')
  .description(
    "Run yarn at the workspace root while preserving nested repositories' yarn.lock files. Forwards all extra args to yarn.",
  )
  .allowUnknownOption(true)
  .action(async () => {
    const yarnArgs = program.args.slice(1); // drop 'yarn' itself
    const {safeYarn} = await import('./commands/safe-yarn.js');
    return safeYarn(yarnArgs);
  });

program
  .command('setup-publish')
  .description(
    'Set up a changesets publish workflow in the current package repo. Writes GitHub Actions workflows, changesets config, .gitignore entries, and patches package.json.',
  )
  .option(
    '--configure-github',
    'Also configure GitHub branch protection on main (requires gh CLI installed and authenticated).',
  )
  .option(
    '--dual-branch',
    'Use dual-branch (main + dev) flow with @next prereleases on dev. Default is single-branch (main only).',
  )
  .option(
    '--scope <scope>',
    'Which NPM secret to reference in the publish workflow: "core" uses NPM_AUTH_TOKEN, "community" uses NPM_AUTH_TOKEN_CM. Defaults to "core".',
    'core',
  )
  .option(
    '--grant-team <slug>',
    'GitHub team slug to grant push access on the repo. Requires gh CLI.',
  )
  .action(async (options) => {
    const {setupPublish} = await import('./commands/setup-publish.js');
    await setupPublish({
      configureGithub: !!options.configureGithub,
      dualBranch: !!options.dualBranch,
      scope: options.scope === 'community' ? 'community' : 'core',
      grantTeam: options.grantTeam,
    });
  });

program
  .command('all [action] [filter] [filter-value]')
  .action((command, filter, filterValue) => {
    executeCommandForEachPackage(
      getLincdPackages(),
      command,
      filter,
      filterValue,
    );
  });
// program.command('all-except [excludedSpaces] [action]').action((excludedSpaces, command) => {
//   executeCommandForEachModule(getLincdModules(), command, null, excludedSpaces);
// });

program.command('dev [target] [mode]').action((target, mode) => {
  developPackage(target, mode);
});

program.command('depcheck').action((target, mode) => {
  depCheck();
});
program.command('depcheck-staged').action((target, mode) => {
  depCheckStaged();
});
program
  .command('check-imports')
  .description(
    'Check the imports of the package in the current folder. Exits 1 when an invalid import is found',
  )
  .action(async () => {
    try {
      await checkImports();
    } catch (report) {
      // checkImports throws the formatted report of every invalid import.
      console.error(typeof report === 'string' ? report : String(report));
      process.exitCode = 1;
    }
  });

program
  .command('package')
  .action((name, command, args: string[]) => {
    let fullCommand = command
      ? command +
        ' ' +
        args
          .slice(0, 3)
          .filter((a) => a && true)
          .join(' ')
      : null;

    //TODO: call
    // let pkgName = process.argv[1];
    // console.log(pkgName);
    // let restArgs = process.argv.slice(2)
    // program.parse([],{from:'user'});
    // program.parse(['--port', '80'], { from: 'user' })

    executeCommandForPackage(name, fullCommand);
  })
  .alias('p')
  .alias('pkg')
  .alias('m')
  .alias('module')
  .description(
    'Searches for a package in this workspace with a partially matching name and executes a command for that package (without needing to execute it from the folder of the package)',
  )
  .argument('<name>', 'the name of the package. Can be a part of the name.')
  .argument(
    '[command]',
    'the lincd command you want to execute. Like dev or build',
  )
  .argument('[args...]', 'the additional arguments of that command');

program.command('enable-capacitor').action(() => {
  addCapacitor();
});

program.parse(process.argv);
