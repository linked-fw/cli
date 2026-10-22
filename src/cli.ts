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
import {program, type Command} from 'commander';
import {CreatePackageError} from './utils/createPackageLocation.js';
import fs from 'fs-extra';
import path from 'path';
import 'require-extensions';
import {unknownCommandError} from './unknown-command.js';
import {installDriftHook} from './localize/drift-hook.js';

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

/** A refusal of the create-* commands exits 1 with the message, not a stack. */
const reportRefusal = (e: unknown) => {
  if (!(e instanceof CreatePackageError)) throw e;
  console.error(chalk.red(e.message));
  process.exitCode = 1;
};

const LOCATION_HELP =
  "packages: part of this app's repository, a workspace member added to its dependencies. packages-local: its own git repository (git init + a first commit) in packages-local/, which the app gitignores; a workspace member through the app's \"packages-local/*\" glob, so npm links it (`linked localize --adopt` sets the app up and installs). Not added to the app's dependencies until it is published.";
const REMOTE_HELP =
  "The new repository's origin; also written to repository.url. Implies --location packages-local.";
const PUSH_HELP = 'Push the first commit to --remote.';
const SKIP_INSTALL_HELP = 'Write the files only: no install, no build, no git.';
const BASE_URI_HELP =
  "The root the package's IRIs are minted under: linkedPackage(name, {baseUri}), shapes at <uri>shape/<package>/<Name>, ontology terms at <uri>ont/<slug>/<Term>. Inside an app it defaults to LINKED_BASE_URI from the environment, then the app's .env.local, then its .env; with none of them the package declares no root and falls back to https://linked.cm/.";
const WHERE_HELP =
  "Inside an app, it goes in packages/ (part of the app's repository) or packages-local/ (its own git repository, linked with `linked localize`); without --location, --remote or --push you are asked, on a terminal.";

/** The three scaffolding commands share the where-flags; `--kind` is create-package's own. */
const withPackageOptions = (command: Command) =>
  command
    .option('--location <where>', LOCATION_HELP)
    .option('--remote <git-url>', REMOTE_HELP)
    .option('--push', PUSH_HELP)
    .option('--skip-install', SKIP_INSTALL_HELP)
    .option('--base-uri <uri>', BASE_URI_HELP);

withPackageOptions(
  program
    .command('create-package')
    .action(async (name, uriBase, options) => {
      try {
        await createPackage(name, uriBase, process.cwd(), options);
      } catch (e) {
        reportRefusal(e);
      }
    })
    .description(
      'Create a new Linked package: an ontology package (<name>-ont: one ontology, no shapes), an asset package (<name>-assets: shapes, components and a backend) or both. Without --kind you are asked, on a terminal. A name that already ends in -ont or -assets keeps it (foo-ont stays foo-ont). ' +
        WHERE_HELP,
    )
    .option(
      '--kind <kind>',
      'ontology, assets or both. `both` creates <name>-ont and <name>-assets; it cannot take --remote (one repository cannot hold two packages).',
    )
    .argument(
      '<name>',
      'The name of the package, without the kind suffix: the package is named <name>-ont or <name>-assets (a name that already ends in the suffix is kept). An npm scope is kept (@acme/foo → @acme/foo-ont).',
    )
    .argument(
      '[uri_base]',
      "The namespace of the ontology package's ontology. Leave blank for https://linked.cm/ont/<name>/ (the ontology slug is <name>, without -ont).",
    ),
);

withPackageOptions(
  program
    .command('create-ont-package')
    .action(async (name, uriBase, options) => {
      try {
        await createPackage(name, uriBase, process.cwd(), {...options, kind: 'ontology'});
      } catch (e) {
        reportRefusal(e);
      }
    })
    .description(
      'Create an ontology package <name>-ont: exactly one ontology (src/ontologies/<name>.ts), no shapes, components or backend. Its ontology slug is <name>, so its terms mint {root}ont/<name>/{Term}. A name that already ends in -ont keeps it. ' +
        WHERE_HELP,
    )
    .argument('<name>', 'The ontology slug; the package is named <name>-ont (foo-ont stays foo-ont).')
    .argument(
      '[uri_base]',
      'The namespace of the ontology. Leave blank for https://linked.cm/ont/<name>/.',
    ),
);

withPackageOptions(
  program
    .command('create-asset-package')
    .action(async (name, options) => {
      try {
        await createPackage(name, undefined, process.cwd(), {...options, kind: 'assets'});
      } catch (e) {
        reportRefusal(e);
      }
    })
    .description(
      'Create an asset package <name>-assets: shapes, components and a backend (src/shapes, src/components, src/backend.ts), and no ontology. A name that already ends in -assets keeps it. ' +
        WHERE_HELP,
    )
    .argument('<name>', 'The package is named <name>-assets (foo-assets stays foo-assets).'),
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
    return createShape(name).catch(reportRefusal);
  })
  .description(
    'Creates a new ShapeClass file for your package. Execute this from your package folder (packages/<name>), not the app root: an app registers no package.',
  )
  .argument(
    '<name>',
    'The name of the shape. Will be used for the file name and the class name',
  );

program
  .command('create-component')
  .action((name, uriBase) => {
    return createComponent(name).catch(reportRefusal);
  })
  .description(
    'Creates a new Component file for your package. Execute this from your package folder (packages/<name>), not the app root: an app registers no package.',
  )
  .argument(
    '<name>',
    'The name of the component. Will be used for the file name and the export name',
  );

program
  .command('create-set-component')
  .action((name, uriBase) => {
    return createSetComponent(name).catch(reportRefusal);
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
    return createOntology(prefix, uriBase).catch(reportRefusal);
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
    return buildAll(options);
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
    'Develop an npm dependency from a git checkout in packages-local/, which the app lists in its workspaces so npm links it. Clones each package (the repository comes from its published `repository` field), sets the app up the first time (workspaces glob, lock-at-rest hook, .gitignore and the matching lockfile; commit those), installs git hooks (or, under core.hooksPath, prints the line to add to each), runs one npm install at the app root and builds the new checkouts. The app root is the topmost directory whose package.json has workspaces, so it can run from inside a member. Name packages exactly as npm names them (@_linked/rdfs, lodash). With no names, reports what is localized.',
  )
  .option(
    '--list',
    'Report the checkouts (name, directory, branch, version), the parked ones and any drift.',
  )
  .option(
    '--check',
    'With --list: print only the drift, and exit 1 when there is any (for CI and scripts).',
  )
  .option(
    '--adopt',
    'Use a checkout that is already in packages-local (e.g. packages-local/_linked-foo for @_linked/foo) as it is: no registry lookup and no clone. For a package created locally, or a clone put there by hand.',
  )
  .option(
    '--parked',
    'Take back every checkout `linked delocalize` parked, then npm install once.',
  )
  .option(
    '--repo <git-url>',
    'Clone this instead of the published repository.',
  )
  .option(
    '--subdir <path>',
    "The package's directory inside the repository (monorepos). The repository is cloned into packages-local/.repos/ and packages-local/<name> links to the package.",
  )
  .option(
    '--build <cmd>',
    'Run this in each new checkout after the install; a failure only warns. Defaults to the checkout\'s own `npm run build` when it has a build script (packages and apps both define one); without one nothing is built. Pass an empty string to build nothing.',
  )
  .option(
    '--dir <path>',
    'Where checkouts live. Only packages-local is accepted: the workspaces glob names it.',
  )
  .option(
    '--relink',
    'Deprecated, does nothing: npm links the checkouts. Exits 0, so old postinstall scripts keep working.',
  )
  .option(
    '--ensure',
    'Deprecated, does nothing but print a hint: drift is reported by --list and before linked start. Exits 0.',
  )
  .action(async (packages: string[], options) => {
    const {runLocalize} = await import('./commands/localize.js');
    return runLocalize(packages, options);
  });

program
  .command('delocalize [packages...]')
  .description(
    'Park checkouts: move them from packages-local/ to .packages-local.parked/, then reinstall the registry copies (npm ci when no checkout remains and the committed lockfile and package.json are unchanged, else npm install and npm rebuild). `linked localize <name>` or `--parked` takes them back. With no names, parks every checkout.',
  )
  .option(
    '--purge',
    'Delete the checkout instead of parking it. Refuses (exit 6) on unsaved work, or when it is not a git repository or git fails.',
  )
  .option(
    '--force',
    'With --purge, delete even a checkout with unsaved work (uncommitted changes, commits no remote has, on a branch or a detached HEAD, a stash) or one git cannot check.',
  )
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

const doctor = program
  .command('doctor')
  .description(
    'Diagnostics for how the dev server loads packages. For checks on how an app uses linked packages, see app-doctor.',
  );

doctor
  .command('resolve')
  .description(
    'Run in an app. For every source workspace and installed @_linked package: the directory Vite\'s dev SSR runner loads it from (or "external" when Vite leaves it to Node), the directory Node resolves it to, and whether Vite bundles it. Flags "overlay" when the two differ (a worktree\'s own checkout) and "two-copies" when they differ for a package Node also loads during linked start (@_linked/cli, and every @_linked package the app\'s vite.config imports). Exits 1 on "two-copies".',
  )
  .option('--json', 'Print the rows as JSON: name, vite, node, bundled, flag.')
  .action(async (options) => {
    const {runDoctorResolve} = await import('./commands/doctor.js');
    return runDoctorResolve(options);
  });

const branch = program
  .command('branch')
  .description(
    'One integration branch across the app and its packages-local/ checkouts. The target it lands in is recorded per repo as git config branch.<name>.linked-target.',
  );

branch
  .command('status')
  .description(
    'Run in an app. Per repo (the root and each packages-local/ checkout): branch, its target, dirty, commits ahead/behind the target and the root\'s integration branch. Flags "off-branch" for a repo on neither the integration branch nor its target.',
  )
  .option('--json', 'Print the integration branch and the rows as JSON.')
  .action(async (options) => {
    const {runBranchStatus} = await import('./commands/branch.js');
    return runBranchStatus(options);
  });

branch
  .command('start <name> [packages...]')
  .description(
    'Run in an app. Put the app root and the named packages-local/ checkouts (@_linked/core, core or _linked-core) on branch <name>, creating it from --target where it does not exist, and record the target. Refuses, switching nothing, when: any of them has uncommitted or untracked changes; --target is missing in a repo where <name> has to be created; <name> equals the target; <name> contains "--" (it separates agent branches); or another worktree has <name> checked out. If a switch fails partway, the repos already switched go back: each to its previous branch, a branch the run created is deleted (kept, with its sha printed, when it moved or another branch forked from it), and the target entry is restored.',
  )
  .requiredOption('--target <branch>', 'The branch the work lands in, e.g. main or dev.')
  .action(async (name: string, packages: string[], options) => {
    const {runBranchStart} = await import('./commands/branch.js');
    return runBranchStart(name, packages, options);
  });

const worktree = program
  .command('worktree')
  .description(
    "An agent's worktree of the app (default <parent of the app root>/wt/<agent>) with a nested worktree of each package it changes, on the branch <base>--<agent>. The base is the root's integration branch, or its current branch. node_modules is shared with the main checkout.",
  );

worktree
  .command('add <agent>')
  .description(
    "Run in an app. Create the app worktree on <base>--<agent> (or detached with --app-detached), symlink node_modules and the gitignored .env files, and add a worktree of each --with package in its packages-local/. A --with checkout not on the base joins it (created from the target), refusing, with nothing changed, when it has changes. Prints the start command.",
  )
  .option('--with <packages>', 'Comma-separated packages-local/ checkouts to change: @_linked/core, core or _linked-core.')
  .option('--app-detached', 'Check the app out detached at the base tip: for work that changes only packages.')
  .option('--port <n>', 'The port for the printed start command.')
  .option('--dataset <name>', 'A dataset of its own for the printed start command (FUSEKI_DATASET).')
  .option('--dir <path>', 'Where to put the worktree.')
  .action(async (agent: string, options) => {
    const {runWorktreeAdd} = await import('./commands/worktree.js');
    return runWorktreeAdd(agent, options);
  });

worktree
  .command('list')
  .description(
    "Run in an app. The app's agent worktrees (on <base>--<agent>, or detached with a package worktree on one) with their nested package worktrees: branch or detached, and whether each branch has landed in the base.",
  )
  .option('--all', 'List every worktree of the app, not only agent worktrees.')
  .option('--json', 'Print the base and the worktrees as JSON.')
  .action(async (options) => {
    const {runWorktreeList} = await import('./commands/worktree.js');
    return runWorktreeList(options);
  });

worktree
  .command('remove <agent>')
  .description(
    "Run in an app. Find the agent's app worktree by its branch <base>--<agent> (a detached one by its package worktrees on that branch, or at the default dir), remove its package worktrees, then the app worktree, then delete its landed agent branches. Refuses, removing nothing, while a branch has not landed or a worktree has changes.",
  )
  .option('--force', 'Remove even when a worktree has changes or a branch has not landed; unlanded branches are kept and their sha printed.')
  .option('--delete-unlanded', 'Also delete agent branches that have not landed (git branch -D), printing the sha each was at.')
  .option('--dir <path>', 'The app worktree directory, instead of finding it by its branch.')
  .action(async (agent: string, options) => {
    const {runWorktreeRemove} = await import('./commands/worktree.js');
    return runWorktreeRemove(agent, options);
  });

const release = program
  .command('release')
  .description(
    "Releasing an integration branch: PRs per repo to its target from branches named <integration>--<what>, framework repos first, the app last.",
  );

release
  .command('plan')
  .description(
    'Run in an app on an integration branch. Per repo on it, in dependency order with the app last: commits, reports and changesets the target lacks, each new report\'s "## PR" section, the release PRs (head <integration>--*) in stack order with their state (via gh), and the next action: open PRs, waiting, merge target back, done or nothing to release. Warns when a changesets repo adds no changeset, and when origin/<target> has commits the local target lacks. It compares against the local target branches and never fetches: fetch and fast-forward them first. Changes nothing.',
  )
  .option('--json', 'Print the plan as JSON.')
  .action(async (options) => {
    const {runReleasePlan} = await import('./commands/release.js');
    return runReleasePlan(options);
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

// Before a command that runs the app's code, report drift between the
// localized checkouts and what npm installed (localize/drift.ts). Never fails it.
installDriftHook(program);

const unknownCommand = unknownCommandError(program, process.argv.slice(2));
if (unknownCommand) {
  console.error(chalk.red(unknownCommand));
  process.exit(1);
}
program.parse(process.argv);
