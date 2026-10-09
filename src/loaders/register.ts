// Registers the CLI's Node module hooks. Called by `launch.ts` before the CLI is
// imported, so every TS/CSS file the CLI later loads from an app flows through them.
import {register} from 'node:module';
import {resolveLoaderMode, type LoaderModeResolution} from '../loader-mode.js';

/**
 * Register the CSS and TS loaders, handing the CSS loader its naming mode.
 *
 * The mode travels as `register()`'s one-shot `data`, not over a MessagePort,
 * on purpose. The hooks thread caches every module it transforms, so a mode that
 * changed after the first stylesheet was loaded would not rename that one — the
 * process would end up with both namings at once, which is the very mismatch
 * this exists to prevent. The mode therefore has to be fixed before any module
 * loads and hold for the life of the process. `resolveLoaderMode` reads it from
 * the same sources, in the same precedence, the CLI applies afterwards.
 */
export function registerLoaders(
  resolution: LoaderModeResolution = resolveLoaderMode(),
): LoaderModeResolution {
  register(new URL('./css-loader.mjs', import.meta.url), {
    data: {mode: resolution.mode},
  });
  register(new URL('./ts-loader.mjs', import.meta.url));
  return resolution;
}
