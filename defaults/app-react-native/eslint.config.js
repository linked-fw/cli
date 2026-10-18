// One flat config for every workspace. `npm run lint` runs `eslint .` from the repo root.
const expoConfig = require('eslint-config-expo/flat');
const tseslint = require('typescript-eslint');

const scope = (configs, files) => [configs].flat().map((config) => ({ ...config, files }));

const mobileFiles = ['apps/mobile/**/*.{js,jsx,ts,tsx,mjs,cjs}'];
const nodeTsFiles = ['services/api/**/*.{ts,tsx,mts}', 'packages/app-shapes/**/*.{ts,tsx,mts}'];

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/.expo/**',
      '**/ios/**',
      '**/android/**',
      '**/dist/**',
      // Mirrors .gitignore: only the enumerated workspace packages under packages/ are this repo's.
      'packages/*',
      '!packages/app-shapes',
    ],
  },

  ...scope(expoConfig, mobileFiles),
  {
    files: mobileFiles,
    rules: {
      // The @_linked/server root barrel pulls express, webpack and react-dom into the bundle.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@_linked/server',
              message:
                'Import @_linked/server by subpath (e.g. @_linked/server/shapes/quadstores/RemoteDataset); the root barrel pulls express, webpack and react-dom.',
            },
          ],
          patterns: [{ group: ['@_linked/server/backend*'], message: 'Backend-only entry.' }],
        },
      ],
    },
  },

  ...scope(tseslint.configs.recommended, nodeTsFiles),
];
