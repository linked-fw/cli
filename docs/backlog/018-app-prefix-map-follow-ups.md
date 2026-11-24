---
summary: >
  After the ontology index and `linked.app.json` (reports 052, 053): publish the schema at its
  `$schema` URL, merge the app template's `linked.app.json` branch with the release, raise the
  cli's `@_linked/core` range to the major with `Prefix.load` and then drop the warning for an
  older core, and settle how a suggested prefix with a hyphen (`server-utils`) reads in an app's
  map.
source: report 052, 10 Nov 2026
status: open
---

# 018 — App prefix map follow-ups

1. **Schema URL.** `linked.app.json` names `"$schema": "https://linked.cm/schema/app/1.json"`;
   the file ships in this package (`schema/app/1.json`) but is not served at that URL yet. Serve
   it there (the site that hosts `linked.cm`), so editors validate the file.
2. **App template repo.** `linked create-app` clones `linked-fw/app-template`'s `main`. Its
   branch `linked-app-json` moves the template's settings into `linked.app.json` and deletes
   `linked.config.js` (report 053). Merge it together with the release of this cli major: before
   it, the published cli would not read the template's settings; after the release, a template
   with `linked.config.js` is refused. Until then this repo's e2e (`create-app.spec.ts`,
   `dual-copy.spec.ts`, `build-app.spec.ts`) fails against `main`; report 053 ran it against the
   branch. A host app that writes a `linked.config.js` into the apps it creates must write
   `linked.app.json` (`server.rawQueries`) instead before the merge, or its new apps are refused.
3. **Core range.** The cli depends on `@_linked/core` `^2.39.0`. Loading the map needs
   `Prefix.load` (the next core major). When that major is the cli's range, remove the tolerance
   in `loadAppPrefixes` / `appPrefixesModuleCode` (an older core is warned about and left as it
   is) so a map is always loaded.
4. **Hyphenated suggested prefixes.** A map prefix is `^[A-Za-z][A-Za-z0-9_]*$`, so the builder
   turns `server-utils` into `server_utils`. An app that wrote Turtle with `server-utils:` before
   writes `server_utils:` once its map is loaded. Either the package's suggested prefix changes to
   a map-legal one, or the app owner picks the prefix by hand; decide per package.
