import * as colors from 'colors';
import type {AdjustedModuleConfig} from './interfaces.js';
import DeclarationPlugin from './plugins/declaration-plugin.js';
import externaliseModules from './plugins/externalise-modules.js';
import WatchRunPlugin from './plugins/watch-run.js';
import {generateScopedName, getPackageJSON, warn} from './utils.js';
// console.log('Webpack '+require('webpack/package.json').version);
// console.log('ts-loader '+require('ts-loader/package.json').version);

import fs from 'fs';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import path from 'path';
import webpack from 'webpack';
// const WebpackLicencePlugin = require('webpack-license-plugin');
// const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
import {exec} from 'child_process';
import CopyPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';
import {BundleAnalyzerPlugin} from 'webpack-bundle-analyzer';
// import tailwindPlugin from 'tailwindcss/plugin';

declare var __dirname: string;
declare var require: any;
declare var process: any;

const NODE_ENV = process.env.NODE_ENV;
const nodeProduction = NODE_ENV == 'production';

// const libraryName = 'lincd';
process.traceDeprecation = true;

function getLincdPackagePaths(packages?) {
  if (!packages) {
    let pkgJson = getPackageJSON();
    packages = {...pkgJson.dependencies, ...pkgJson.devDependencies};
  }
  let lincdPackagePaths = [];
  for (var dependency of Object.keys(packages)) {
    try {
      let pkgJson = require(dependency + '/package.json');
      if (pkgJson.lincd) {
        let pkgPath = require.resolve(dependency + '/package.json');
        lincdPackagePaths.push(pkgPath.substring(0, pkgPath.length - 13));
      }
    } catch (err) {
      // console.log("could not find "+dependency);
    }
  }
  return lincdPackagePaths;
}

export function generateWebpackConfig(
  buildName,
  moduleName,
  config: AdjustedModuleConfig = {},
) {
  if (!config.externals) config.externals = {};
  if (!config.internals) config.internals = [];

  var watch = config.watch;
  var productionMode = nodeProduction || config.productionMode;

  var es5 = config.target == 'es5';
  var es6 = config.target == 'es6';

  //remove the scope (used for filenames for example)
  var cleanModuleName = moduleName.replace(/@[\w\-]+\//, '');

  var configFile;
  if (es5 && fs.existsSync('tsconfig-es5.json')) {
    configFile = 'tsconfig-es5.json';
  } else {
    configFile = 'tsconfig.json';
  }

  if (!fs.existsSync(configFile)) {
    warn('Cannot find ' + configFile);
    process.exit();
  }

  let tsConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));

  var plugins: any[] = [
    // new webpack.DefinePlugin({
    //   'process.env.BROWSER': JSON.stringify(true),
    //   'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    // }),
    // new webpack.NoEmitOnErrorsPlugin(),
    // new ExtractTextPlugin(config.cssFileName ? config.cssFileName : cleanModuleName + '.css'),
    new MiniCssExtractPlugin({
      // linkType: false,
      filename: config.cssFileName
        ? config.cssFileName
        : cleanModuleName + '.css',
    }),
    //currently not compatible with webpack 5
    // new WebpackLicencePlugin({
    //   excludedPackageTest: (packageName, version) => {
    //     return packageName.indexOf('lincd') !== -1;
    //   },
    // }),

    //NOTE: grunt comes with a copy task, which is ran during `linked build` but cannot run during `linked dev`
    //so here we ALSO copy the same files to cover dev flow
    new CopyPlugin({
      patterns: [
        {
          from: 'src/**/*.css',
          to({context, absoluteFilename}) {
            // console.log(chalk.magenta(context),chalk.magenta(absoluteFilename),process.cwd());
            //turn absolute path into the right lib path (lib is NOT in webpack output path, so need to use '../')
            let outputPath = absoluteFilename
              .replace(process.cwd(), '')
              .replace('/src/', '../lib/');
            // console.log(chalk.blueBright(outputPath));
            return Promise.resolve(outputPath);
          },
          noErrorOnMissing: true,
        },
      ],
    }),
  ];

  if (config.debug) {
    plugins.push(new WatchRunPlugin());
  }

  if (config.afterBuildCommand || config.afterFirstBuildCommand) {
    let executedFirstCommand = false;
    plugins.push({
      apply: (compiler) => {
        compiler.hooks.afterEmit.tap('AfterEmitPlugin', (compilation) => {
          if (config.afterBuildCommand) {
            exec(config.afterBuildCommand, (err, stdout, stderr) => {
              if (stdout) process.stdout.write(stdout);
              if (stderr) process.stderr.write(stderr);
            });
          }
          if (config.afterFirstBuildCommand && !executedFirstCommand) {
            executedFirstCommand = true;
            exec(config.afterFirstBuildCommand, (err, stdout, stderr) => {
              if (stdout) process.stdout.write(stdout);
              if (stderr) process.stderr.write(stderr);
            });
          }
        });
      },
    });
  }

  if (config.analyse) {
    plugins.push(new BundleAnalyzerPlugin());
  }

  if ((es6 || config.declarations === true) && !config.declarations === false) {
    plugins.push(
      new DeclarationPlugin({
        out: (config.filename ? config.filename : cleanModuleName) + '.d.ts',
        root: config.outputPath ? config.outputPath : './lib/',
        debug: 'debug' in config ? config.debug : false,
      }),
    );
  }

  // var resolvePlugins = [
  // new TsconfigPathsPlugin({
  //   configFile: configFile,
  //   silent: true,
  // }),
  // ];

  var aliases = config.alias || {};

  let postcssPlugins = [];
  if (!config.cssMode) {
    config.cssMode = 'tailwind';
  }

  if (config.cssMode === 'tailwind') {
    let lincdPackagePaths;
    //IF this package is including sources from another lincd package in its bundle (usually not the case)
    if (config.internals) {
      //THEN make sure that we also look for tailwind classes in those packages
      //pass the list of internal packages, or if all, pass null because it will look up all the package.json:dependencies
      lincdPackagePaths = getLincdPackagePaths(
        config.internals !== '*' ? config.internals : null,
      ).map((path) => {
        return path + '/lib/**/*.{js,mjs}';
      });
    }

    postcssPlugins.push([
      '@tailwindcss/postcss',
      {
        //Tailwind v4 has very limited options for postcss
        //use @ directives instead
        // content: {
        //   files: ['./src/**/*.{tsx,ts}', ...lincdPackagePaths],
        // },
        // plugins: [],
      },
    ]);
  } else {
    // postcss mode: use postcss-nested to enable nesting of css
    postcssPlugins.push(
      ['postcss-import', {}],
      [
        'postcss-preset-env',
        {
          features: {'nesting-rules': true},
        },
      ],
    );
  }

  let rules: any[] = [
    {
      test: /\.css$/,
      use: [
        MiniCssExtractPlugin.loader,
        {
          loader: 'css-loader',
          options: {
            url: false,
            importLoaders: 1,
            modules: {
              mode: 'local',
              auto: (resourcePath: string) => {
                //make sure this only applies to .module.css files, and not to tailwind
                return (
                  /\.module\.css$/i.test(resourcePath) &&
                  !/tailwind/i.test(resourcePath)
                );
              },
              getLocalIdent: (context, localIdentName, localName) => {
                return generateScopedName(localName, context.resourcePath);
              },
            },
          },
        },
        {
          loader: 'postcss-loader',
          options: {
            postcssOptions: {
              plugins: postcssPlugins,
            },
          },
        },
      ],
    },
    // {
    //   test: /\.(ts|tsx)$/,
    //   exclude: /node_modules/,
    //   //include: [path.join(process.cwd(),"frontend")], // only bundle files in this directory
    //   use: {
    //     loader: "babel-loader", // cf. .babelrc.json in this folder and browser list in package.json
    //     options: {
    //       // plugins: productionMode ? [] : ["react-refresh/babel"],
    //       cacheCompression: false,
    //       cacheDirectory: true,
    //       presets: [
    //         "@babel/preset-env",
    //         ["@babel/preset-react", {"runtime": "automatic"}],
    //         "@babel/preset-typescript",
    //       ],
    //       plugins: [
    //         "@babel/plugin-transform-runtime",
    //         ["@babel/plugin-proposal-decorators",{
    //           decoratorsBeforeExport:true
    //         }]
    //       ],
    //     },
    //   },
    // },
    {
      test: /\.tsx?$/,
      use: [
        {
          loader:
            'ts-loader?' +
            JSON.stringify({
              configFile: configFile,
              compilerOptions: {
                declaration: !es5,
                /*
                  for webpack we overwrite the module settings of the modules' tsconfig file
                  because we NEED esnext for code splitting. But the VM we currently use for the registry does not support esnext modules
                 */
                module: 'esnext',
                moduleResolution: 'node',
              },
              ...config.tsConfigOverwrites,
            }),
        },
      ],
    },
    {
      test: /[\w]+/,
      use: [
        {
          loader: path.resolve(__dirname, 'plugins', 'check-imports.js'),
          options: {},
        },
      ],
    },
    // {
    //   enforce: 'pre',
    //   test: /\.js$/,
    //   use: [
    //     {
    //       loader: 'source-map-loader',
    //     },
    //   ],
    // },
  ];
  if (es5 && config.internalsources && config.internalsources.length > 0) {
    //usually a module that transpiles to es5 will only have es5 code in the bundle.
    //however a module that INTERNALISES other dacore modules will directly include es6 code from @dacore/other_modules/lib
    //which eventually results in an import of @dacore/core being bundled as 'const =', which trips up old browsers
    //so we fix that here by just referring directly to the typescript source instead of the transpiled js for internalised modules
    //however this means that for internalised modules THE SOURCE CODE NEEDS TO BE AVAILABLE. This is currently NOT the case with how we publish modules to yarn
    //so that means internalised modules need to be LOCALLY AVAILABLE as workspace packages
    plugins.push(
      new webpack.NormalModuleReplacementPlugin(/lincd\/lib\//, (resource) => {
        let moduleName = resource.request.match(/lincd\/lib\//)[1];
        if (config.internalsources.indexOf(moduleName) !== -1) {
          console.log(
            colors.magenta(
              'internal sources + ES5: Replacing /lib/ with /src/  for source-internalised module ' +
                moduleName,
            ),
          );
          resource.request = resource.request.replace('/lib/', '/src/');
          console.log(
            colors.magenta('internal sources + ES5: ' + resource.request),
          );
          console.log(
            colors.red(
              "WARNING: Make sure you have the TYPESCRIPT SOURCE FILES of the modules listed as 'internal' AVAILABLE ON YOUR LOCAL MACHINE. So if you check in node_modules/your-internalised-module - that should be a symbolic link and you will find a 'src' folder with typescript files there.",
            ),
          );
        }
      }),
    );
  }

  return {
    entry: config.entry
      ? config.entry
      : tsConfig.files
        ? tsConfig.files
        : './src/index.ts',
    output: {
      filename:
        (config.filename ? config.filename : cleanModuleName) +
        (es5 ? '.es5' : '') +
        '.js',
      path: path.resolve(process.cwd(), config.bundlePath || 'dist'),
      devtoolModuleFilenameTemplate: moduleName + '/[resource-path]',
    },
    devtool: productionMode ? 'source-map' : 'cheap-module-source-map',
    // devtool: productionMode ? 'cheap-source-map' : 'cheap-source-map',
    mode: productionMode ? 'production' : 'development',
    //fixing a persistent but strange build error here that showed up once, this is a workaround. See: https://github.com/webpack-contrib/css-loader/issues/447
    // node: {
    //   fs: 'empty',
    //   child_process: 'empty',
    // },
    resolve: {
      extensions: ['.webpack.js', '.js', '.ts', '.tsx', '.json'],
      alias: aliases,
      // plugins: resolvePlugins,
      fallback: {crypto: false},
    },
    resolveLoader: {
      modules: [
        path.join(__dirname, 'plugins'), //load webpack our own custom-made loaders from the plugin folder
        path.join(__dirname, '..', 'node_modules'), //load webpack loaders from this lincd-cli library instead of the library that's using it to build its project
        'node_modules',
      ],
    },
    optimization: {
      minimize: productionMode,
      minimizer: [
        new TerserPlugin({
          extractComments: {
            condition: /^\**!|@preserve|@license|@cc_on/i,
            banner: (licenseFile) => {
              return `License information can be found in ${licenseFile} and oss-licences.json`;
            },
          },
        }),
      ],
    },
    watch: watch,
    watchOptions: {
      ignored: ['**/*.d.ts', '**/*.js.map', '**/*.css.json'],
      aggregateTimeout: 500,
    },
    module: {
      rules,
    },
    //See plugins/externalise-modules.ts We're passing in a function here that determines what to exclude from the bundle and what not
    //See also https://webpack.js.org/configuration/externals/
    externals: externaliseModules(config, es5),
    plugins: plugins,
    stats: {
      errorDetails: true, //config.debug,
      chunks: false,
      children: true,
      version: true,
      hash: false,
      entrypoints: false,
      modules: false,
    },

    //hide some info from output when in watch mode to keep it succinct
    //stats:{chunks:!watch,version:!watch}//hide some info from output when in watch mode to keep it succinct
    cache: {
      // https://webpack.js.org/configuration/other-options/#cache
      type: 'filesystem',
      // cacheDirectory: path.resolve(process.cwd(),"node_modules",".cache","webpack"),
      // name: "lincd-webpack-cache",
    },
  };
}
