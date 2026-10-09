// Stands in for `cli.js` when tests/unit/cssLoaderMode.test.ts bundles the real
// `launch.ts`. It does what every app-serving command does before it touches an
// app module — load the app's environment with the CLI's own loader — and then
// imports the app, whose package stylesheet goes through the CSS loader.
//
// It prints the NODE_ENV the CLI ended up with next to the class names the
// loader produced, so the test can hold the two against each other.
import path from 'path';
import {pathToFileURL} from 'url';
import {ensureEnvironmentLoaded} from '../../../src/lifecycle.js';

await ensureEnvironmentLoaded();
const styles = (
  await import(pathToFileURL(path.join(process.cwd(), 'main.js')).href)
).default;
process.stdout.write(
  '\n@@RESULT@@' +
    JSON.stringify({nodeEnv: process.env.NODE_ENV ?? null, styles}) +
    '\n',
);
