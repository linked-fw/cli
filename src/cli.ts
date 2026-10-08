#!/usr/bin/env tsx
//The line above calls the TSX typescript executer as runtime, which extends node.js and supports running typescript
// see: https://www.npmjs.com/package/tsx

import chalk from 'chalk';
import {
  addCapacitor,
  buildAll,
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
import {CreatePackageError} from './utils/createPackageLocation.js';
import fs from 'fs-extra';
import path from 'path';
import 'require-extensions';
import {unknownCommandError} from './unknown-command.js';
import {checkOneCopy} from './localize/ensure.js';

/**
 * Run an async command action and report a failure the way the rest of this
 * CLI does — one red message and exit code 1 — instead of letting the rejection
 * escape the action and print a raw unhandled-rejection stack.
 */
const runAppCommand = async (run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? 'Unknown error');
    console.error(chalk.red(message));
    if (process.env.LINKED_DEBUG && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
};

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
    const {startWithVite} = await import('./commands/start.js');
    return startWithVite({env: options?.env, apiOnly: options?.apiOnly});
  })
  .option('--env <env>', 'The node environment to use. Default is "development"')
  .option(
    '--api-only',
    'Serve only the backend API: no vite.config, src/App.tsx or src/routes.tsx needed; page requests get a 404',
  )
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
  .action(async (name, uriBase, options) => {
    try {
      await createPackage(name, uriBase, process.cwd(), options);
    } catch (e) {
      if (!(e instanceof CreatePackageError)) throw e;
      console.error(chalk.red(e.message));
      process.exitCode = 1;
    }
  })
  .description(
    "Create a new folder with all the required files for a new Linked package. Inside an app, it goes in packages/ (part of the app's repository) or packages-local/ (its own git repository, linked with `linked localize`); without --location, --remote or --push you are asked, on a terminal.",
  )
  .option(
    '--location <where>',
    "packages: part of this app's repository, a workspace member added to its dependencies. packages-local: its own git repository (git init + a first commit), linked and recorded by `linked localize` and not added to the app's dependencies until it is published.",
  )
  .option(
    '--remote <git-url>',
    "The new repository's origin; also written to repository.url. Implies --location packages-local.",
  )
  .option('--push', 'Push the first commit to --remote.')
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
    // Vite is the only app build. An app without a `vite.config.{ts,js,mjs}`
    // is rejected by name rather than falling back to anything.
    await runAppCommand(async () => {
      const {assertViteApp, buildViteApp} = await import(
        './commands/build-app.js'
      );
      assertViteApp();
      await buildViteApp({
        environmentNames: splitEnvOption(options?.env),
        target: options?.target,
        publish: options?.publish === true,
        revision: options?.revision,
        allowDirty: options?.allowDirty === true,
      });
    });
  })
  .option('--env <env>', 'The node environment to use. Default is "development"')
  .option('--target <target>', 'Build target: web or capacitor')
  .option(
    '--publish',
    'Upload the release after a successful web build (off by default; use `linked publish-app`)',
  )
  .option(
    '--revision <sha>',
    'Revision identifying the release. Defaults to LINKED_RELEASE_REVISION, GITHUB_SHA, then git HEAD',
  )
  .option(
    '--allow-dirty',
    'Build from a working tree with uncommitted changes; the release revision gets a "-dirty" suffix',
  )
  .description(
    'Build the linked app frontend and backend for production, and write a release manifest. Requires a vite.config in the app root.',
  );

program
  .command('publish-app')
  .option('--env <env>', 'The node environment to use')
  .option(
    '--manifest <path>',
    'Release manifest to publish, relative to the app root. Default public/bundles/linked-release.json',
  )
  .option('--yes', 'Upload the verified release. Without it this is a dry run')
  .action(async (options) => {
    // Retry or inspect an existing release without rebuilding the app.
    await runAppCommand(async () => {
      const {ensureEnvironmentLoaded} = await import('./lifecycle.js');
      const {resolveAppAssetsStore} = await import(
        './app-release/app-assets-store.js'
      );
      const {publishApp} = await import('./commands/publish-app.js');
      await ensureEnvironmentLoaded(splitEnvOption(options?.env));
      // The store is resolved by publishApp, after the manifest is read.
      await publishApp({
        manifestPath: options?.manifest,
        resolveStore: () => resolveAppAssetsStore(),
        yes: options?.yes === true,
      });
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
    await runAppCommand(async () => {
      const {serveCompiledApp} = await import('./commands/serve-app.js');
      await serveCompiledApp({environmentNames: splitEnvOption(options?.env)});
    });
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
  .command('localize [packages...]')
  .description(
    'Develop an npm dependency from a git checkout: clone it, install inside the checkout, build it and symlink it into node_modules — without touching package.json or package-lock.json. Name packages exactly as npm names them (@_linked/rdfs, lodash); the repository is read from the published `repository` field. With no names, reports what is localized.',
  )
  .option('--list', 'Report what is localized rather than localizing anything.')
  .option(
    '--adopt',
    'Link a checkout that is already in packages-local under its localize name (e.g. packages-local/_linked-foo for @_linked/foo): install, build, link and record it, without cloning or asking the registry. For a package created locally, or a clone put there by hand.',
  )
  .option(
    '--check',
    'With --list: exit 1 when something recorded is not actually linked.',
  )
  .option(
    '--relink',
    'Recreate the recorded symlinks. This is what a postinstall runs.',
  )
  .option(
    '--ensure',
    "Remove every localized checkout's own copy of a package the app provides, and exit 0. Never runs npm; prints nothing when there is nothing to remove. For an app's npm pre* scripts (linked start, script, call and build-all already run it).",
  )
  .option(
    '--reinstall <package>',
    "npm install inside that package's checkout, then remove its own copies of what the app provides. Use this instead of running npm install in a checkout by hand.",
  )
  .option('--dir <path>', 'Where checkouts live (default: packages-local).')
  .option(
    '--repo <git-url>',
    "Clone this instead of the published repository, and record it. With --adopt: record this instead of the checkout's origin.",
  )
  .option(
    '--subdir <path>',
    "The package's directory inside the repository (monorepos).",
  )
  .option(
    '--build <cmd>',
    'Run this in the checkout after installing; a failure only warns. Defaults to `linked build`; pass an empty string to build nothing.',
  )
  .option(
    '--force',
    'Overwrite a symlink pointing outside the checkout directory.',
  )
  .option(
    '--no-prune',
    "Keep every checkout's node_modules as npm installed it. By default, after installing (and on --relink and --reinstall) a checkout's own copy of something the app provides is removed: a localized sibling, a runtime dependency of a localized checkout that the app has at a version satisfying every localized range, react or react-dom. The checkout then loads the app's copy instead of a second one. A copy the app's version does not satisfy is kept, with a warning.",
  )
  .action(async (packages: string[], options) => {
    const {runLocalize} = await import('./commands/localize.js');
    return runLocalize(packages, options);
  });

program
  .command('delocalize [packages...]')
  .description(
    'Undo localize: unlink the packages and forget them, keeping the checkout. With no names, undoes every localized package.',
  )
  .option('--purge', 'Also delete the checkout.')
  .option('--force', 'With --purge, delete even a checkout localize refuses.')
  .action(async (packages: string[], options) => {
    const {runDelocalize} = await import('./commands/localize.js');
    return runDelocalize(packages, options);
  });

program
  .command('app-doctor')
  .description(
    "Run in an app. Checks how the app uses linked packages: Vite pre-bundle entries that don't resolve (and the fix), linked packages whose dependencies don't support the app's React version (and which to bump), and hand-written entries that are now generated and can be removed. Exits 1 if anything needs fixing.",
  )
  .action(async () => {
    const {runAppDoctor} = await import('./commands/app-doctor.js');
    return runAppDoctor();
  });

program
  .command('setup-publish')
  .description(
    "Set up the changesets publish pipeline in the current package repo. Writes the pr.yml/publish.yml callers of the shared workflows in the repo's own org .github repo, changesets config, .gitignore entries, and patches package.json.",
  )
  .option(
    '--configure-github',
    'Also apply the uniform branch protection on main and enable auto-merge (requires gh CLI installed and authenticated).',
  )
  .option(
    '--dual-branch',
    'Deprecated and ignored: the main + dev flow and its @next prereleases are retired. Accepted only so stale scripts still set the repo up.',
  )
  .option(
    '--scope <scope>',
    'Deprecated and ignored: the npm secret is NPM_AUTH_TOKEN in every org, holding that org\'s own token. Accepted only so stale scripts still set the repo up.',
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
      scope: options.scope,
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
    'the linked command you want to execute. Like dev or build',
  )
  .argument('[args...]', 'the additional arguments of that command');

program.command('enable-capacitor').action(() => {
  addCapacitor();
});

// One copy, always (localize/ensure.ts): before a command that runs the app's
// code, remove any localized checkout's own copy of what the app provides.
// Stat-only, never runs npm, silent when clean, a no-op with no
// local-packages.json, and it never throws.
const ONE_COPY_COMMANDS = new Set(['start', 'script', 'call', 'build-all']);
program.hook('preAction', (_program, actionCommand) => {
  if (ONE_COPY_COMMANDS.has(actionCommand.name())) checkOneCopy(process.cwd());
});

const unknownCommand = unknownCommandError(program, process.argv.slice(2));
if (unknownCommand) {
  console.error(chalk.red(unknownCommand));
  process.exit(1);
}
program.parse(process.argv);
