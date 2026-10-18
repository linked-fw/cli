---
"@_linked/cli": patch
---

`create-app --template react-native`: the template moves to `@_linked/server` 3.0.0. `apps/mobile` sends its queries through `RemoteDataset` (`@_linked/server/shapes/quadstores/RemoteDataset`, the renamed `BackendAPIStore`) in its no-`url` form, so the API URL is still resolved once in `src/shell/env.ts` and reaches the API through `SITE_ROOT`. `services/api` pins the same server release and `@_linked/s3` 1.6.3, which no longer depends on `@_linked/server` 2, so the install has one server copy.
