#!/usr/bin/env node
// Bootstrap entry for the `linked` bin. Registers Node module hooks at
// the top level, then dynamically imports the CLI so any TS/CSS that the
// CLI later loads from a user's app flows through these hooks.
//
// We use a custom ts-loader (based on esbuild) instead of `tsx` so we can
// force `experimentalDecorators: true` on the transform — @_linked/core
// ships legacy-signature property decorators and tsx/esbuild's default
// otherwise emits TC39 standard decorators, breaking property
// registration in user scripts.
//
// The hooks run on their own thread, which never sees the app's `.env`: the CLI
// loads it later. So the CSS loader is told its naming mode here, resolved
// before anything loads — see loader-mode.ts.
import {registerLoaders} from './loaders/register.js';

registerLoaders();

import('./cli.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
