// Metro passes this file as `extends` for every module it transforms, node_modules included (so @_linked/*), and
// Jest (jest-expo) picks it up too. No root babel.config.js is needed: Metro's Babel root is apps/mobile.
module.exports = function (api) {
  // Cached for the process lifetime and in Metro's transform cache: after editing this file (or the plugin),
  // restart with `npx expo start --clear`.
  api.cache(true);
  return {
    // babel-preset-expo is installed nested under expo; resolve it from there, as Expo's own default config does.
    presets: [require.resolve('babel-preset-expo', { paths: [require.resolve('expo/package.json')] })],
    // Metro rejects `import('x.json', { with: { type: 'json' } })`, used by every Linked ontology package.
    plugins: [require.resolve('./babel/stripJsonImportAttributes')],
  };
};
