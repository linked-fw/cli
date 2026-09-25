---
summary: Release publishing now asks file stores to preserve every validated object key exactly,
  preventing path sanitization from breaking the URLs embedded in production bundles.
---

# Preserved release object keys

## Outcome

The app release publisher now passes `preservePath: true` for every artifact it writes through
`IFileStore.saveFile`. It already disabled duplicate renaming with `preventDuplicates: false`;
together these options state the complete release contract: the validated manifest key must be the
stored key.

No CLI command changed. Both publication paths receive the fix:

- `linked build-app --publish`
- `linked publish-app --yes`

## Why this is required

The production bundle contains URLs derived from the release manifest. If a store lowercases,
flattens, sanitizes, or suffixes an object key, the upload may succeed while the browser requests a
different path and receives a 404.

Release keys are not arbitrary input. Before upload, the publisher normalizes each source path and
object key, recomputes the expected key from the release prefix, and rejects any mismatch. The file
store can therefore preserve the validated relative path without weakening traversal protection.

## Publication flow

1. Load and validate the release manifest and destination.
2. Re-hash each local artifact and compare it with the manifest.
3. Save it with its MIME type, cache policy, `preventDuplicates: false`, and `preservePath: true`.
4. Reject a store response that does not end in the exact requested object key.
5. Verify the remote size and hash when the store implements `statFile`.
6. Upload the release manifest last so an incomplete release is never marked complete.

## Compatibility

Publishing requires an `IFileStore` implementation that supports the `preservePath` option. The
matching `@_linked/core` change defines the option, and the matching `@_linked/server`
`LocalFileStore` change preserves safe paths while rejecting absolute and traversal paths.

A third-party or older store that rewrites keys remains unsupported. The publisher detects a
different returned location and stops with an explicit exact-key error.

## Verification

The publisher unit test asserts that release writes include both `preventDuplicates: false` and
`preservePath: true`. Existing tests also cover manifest-last ordering, prefix validation, local
hash checks, destination checks, remote verification, resumable publication, and rejection of a
store that renames its object.

During wrapup, `npm run build` and all 309 unit tests passed. The unrelated create-app Playwright
test could not start its Fuseki test container: on two attempts, Testcontainers timed out waiting
60 seconds for `Started.*Server`, before the test body ran.

## Review

- The change is intentionally limited to app release publication; ordinary file uploads retain
  their existing store behavior.
- The manifest remains the authority for paths, hashes, MIME types, and cache policy.
- Deployment must use compatible Core, Server, and CLI releases together.
