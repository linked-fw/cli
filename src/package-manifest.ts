/**
 * Whether a package actually publishes a CommonJS build.
 *
 * A package exposes CJS by pointing `main` at it or by declaring a `require`
 * condition in its `exports` map. Most do neither — they are `"type": "module"`
 * with an `import`-only exports map — and yet a second full `tsc` pass ran for
 * them and copied output into `lib/cjs` that nothing could ever resolve.
 *
 * Keyed on the manifest rather than on the presence of `tsconfig-cjs.json`, so
 * a package opts out by describing itself honestly rather than by deleting a
 * file.
 */
export const packagePublishesCjs = (packageJson: any): boolean => {
  if (!packageJson) return false;
  if (typeof packageJson.main === 'string' && packageJson.main.includes('cjs')) {
    return true;
  }
  const entries = Object.values(packageJson.exports ?? {});
  return entries.some(
    (entry: any) => entry && typeof entry === 'object' && 'require' in entry,
  );
};
