import createLoader from 'create-esm-loader';
// import parseCSS from 'css-parse';
import {generateScopedName} from '../utils.js';
import {cssModuleExports, generateScopedNameProduction} from '../css-module-names.js';
import {cssNamingModeFor, type CssNamingMode} from '../loader-mode.js';

// Which names to produce. NOT read from `process.env` at transform time: this
// file runs on the module-hooks thread, whose env is a copy taken when the hooks
// were registered — before the CLI loads the app's `.env`. `launch.ts` resolves
// the mode up front and passes it in through `initialize`. The env fallback only
// serves someone registering this loader by hand without `data`.
let namingMode: CssNamingMode = cssNamingModeFor(process.env.NODE_ENV);

export async function initialize(data?: {mode?: CssNamingMode}) {
  if (data?.mode === 'development' || data?.mode === 'production') {
    namingMode = data.mode;
  }
}

const cssLoader = {
  resolve(specifier, opts) {
    //check if the url is css
    if (specifier.endsWith('.css')) {
      // console.log(`##LOADER option resolve ${specifier}`);
      //and not a node_module (because we don't need to process node_modules)
      if (specifier.startsWith('.')) {
        // console.log(`##LOADER resolve ${specifier} - ${specifier.startsWith('.') ? 'local' : 'node_module'}`);
        let {parentURL} = opts;
        let url = new URL(specifier, parentURL).href;
        return {url};
      } else {
        // console.log(`##LOADER NOT RESOLVING ${specifier}`);
      }
    }
  },
  format(url, opts) {
    //check if the url is css and not a node_module
    if (url.endsWith('.css')) {
      // console.log(`##LOADER format ${url} - ${url.startsWith('.') ? 'local' : 'node_module'}`);

      return {format: 'module'};
    }
  },
  transform(source, opts) {
    const {url} = opts;
    //check if the url is css and not a node_module
    if (url.endsWith('.css')) {
      // console.log(`##LOADER transform ${url} - ${url.startsWith('.') ? 'local' : 'node_module'}`);
      //if yes, convert the CSS source to a JSON object with original selectors as keys
      //and the converted class names as values
      let cssClassesObject = parseCssToObject(String(source), opts.url);
      let finalSource = JSON.stringify(cssClassesObject, null, 2);
      return {source: `export default ${finalSource};`};
    }
  },
};

function parseCssToObject(rawSource: string, filename) {
  // Must produce the names the Vite builds produce for the same file — see
  // css-module-names.ts. The server renders with these; the client's stylesheet
  // is written with Vite's. Anything but a development run serves compiled
  // output (see startServer), so only 'development' gets the dev names — a
  // `staging` or unset NODE_ENV must still match the production stylesheet.
  // `namingMode` carries that decision (see `initialize` above).
  const output = cssModuleExports(
    rawSource,
    filename,
    namingMode === 'development' ? generateScopedName : generateScopedNameProduction,
  );
  // console.log(myResults);
  // for (const rule of parseCSS(rawSource).stylesheet.rules) {
  //   if(rule.selectors)
  //   {
  //     let selector = rule['selectors'].at(-1); // Get right-most in the selector rule: `.Bar` in `.Foo > .Bar {…}`
  //     if (selector[0] !== '.') break; // only care about classes
  //
  //     selector = selector
  //       .substring(1) // Skip the initial `.`
  //       .match(/(\w+)/)[1]; // Get only the classname: `Qux` in `.Qux[type="number"]`
  //
  //     output[selector] = selector;//getClassStyles(rule['declarations']);
  //     // : selector;
  //   }
  // }

  return output;
}

function getClassStyles(declarations) {
  const styles = {};

  for (const declaration of declarations) {
    styles[declaration['property']] = declaration['value'];
  }

  return styles;
}
//@ts-ignore
export const {resolve, load} = await createLoader(cssLoader);
