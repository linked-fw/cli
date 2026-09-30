---
summary: >
  Nine packages carry `declare module '*.module.css'` in `src/types.ts` while importing no CSS at
  all — `dcat`, `dcmi`, `fuseki`, `org`, `owl`, `s3`, `server`, `sioc`, `xsd`. Removing the
  declaration is not free: the `exports` wildcard makes `./types` a resolvable published subpath
  today, so deleting the file is a published-types change, not a cleanup. `sioc` additionally has
  a separate `src/custom-declarations.ts` that is being removed on its own.
status: Open — needs a decision on whether `./types` is a supported subpath
---

# 006 — `declare module '*.module.css'` in packages that import no CSS

The CLI's package template puts a `src/types.ts` holding

```ts
declare module '*.module.css';
```

into every scaffolded package, whether or not the package ever imports a stylesheet
(`defaults/package/src/types.ts`, still present on `main` after today's template rework). Nine
published packages carry it with no CSS anywhere in `src`:

`dcat`, `dcmi`, `fuseki`, `org`, `owl`, `s3`, `server`, `sioc`, `xsd`

Five packages genuinely need it — `auth`, `primitives`, `rdfs`, `schema`, `shape-ui` — and for
those the declaration should move into a `.d.ts` instead, which TypeScript 7 requires anyway (see
[004](004-typescript-7-is-blocked-by-moduleresolution.md); the move was verified to compile with
zero errors).

## Why deleting it is not free

Each of these packages has a wildcard in its `exports` map, which makes **`./types` a resolvable
published subpath today**. Removing `src/types.ts` removes a subpath consumers can import right
now, so this is a change to the published type surface and belongs in a coordinated release, not
in a drive-by sweep.

Nobody has measured whether anything actually imports `<pkg>/types`. That measurement — a search
across the fleet and CN for `from '@_linked/*/types'` — is the first step, and may turn this into
a trivially safe removal.

## Scoping note

`sioc` also has a separate `src/custom-declarations.ts` (present on `origin/main` as of today)
which is being deleted independently. Check whether that landed before touching `sioc`, so the
two changes do not collide.
