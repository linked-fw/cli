/**
 * Babel plugin: turn a dynamic `import()` whose specifier is computed into a rejected promise.
 *
 * Some Node-only paths in the Linked packages load a module by a variable specifier, e.g. core's
 * `loadOntologyFiles`:
 *   const specifier = 'node:fs/promises';
 *   await import(specifier);
 * The variable keeps bundlers from resolving it. Metro cannot resolve it either and leaves the `import()` in the
 * bundle, and Hermes cannot compile `import()` at all, so `expo export` fails with "Invalid expression encountered".
 * Such a module does not exist on a device (no `node:fs`), so the call becomes
 *   Promise.reject(new Error('… not available in React Native'))
 * and the caller sees the rejection it would see for a module that fails to load. It applies under Jest too
 * (jest-expo reads this Babel config), so tests see what the device sees. A specifier that is a static
 * string is left untouched: Metro bundles it as an ordinary async module.
 */

function isStatic(node) {
  if (!node) return false;
  if (node.type === 'StringLiteral') return true;
  return node.type === 'TemplateLiteral' && node.expressions.length === 0;
}

const path = require('path');

module.exports = function rejectComputedImports({ types: t }) {
  // Names the file, so a computed import() in the app's own code is easy to find.
  const rejection = (state) => {
    const file = state.filename ? ` (${path.relative(state.cwd || process.cwd(), state.filename)})` : '';
    return t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('reject')), [
      t.newExpression(t.identifier('Error'), [
        t.stringLiteral(`import() with a computed specifier is not available in React Native${file}`),
      ]),
    ]);
  };
  return {
    name: 'reject-computed-imports',
    visitor: {
      // Default parser output (what Metro and babel-preset-expo use): a CallExpression with an `Import` callee.
      CallExpression(nodePath, state) {
        const { callee, arguments: args } = nodePath.node;
        if (callee.type !== 'Import' || isStatic(args[0])) return;
        nodePath.replaceWith(rejection(state));
      },
      // With the parser option `createImportExpressions`: an ImportExpression with `source`.
      ImportExpression(nodePath, state) {
        if (isStatic(nodePath.node.source)) return;
        nodePath.replaceWith(rejection(state));
      },
    },
  };
};
