---
'@_linked/cli': patch
---

Stop `buildFrontend` calling the deprecated `LinkedFileStorage.getDefaultDataset`, and publish CDN assets under the names they were built with.

The legacy `public/` upload path was the last caller of a `Dataset`-era alias in
this package. Core forwards it to `getDefaultStore` today, but the aliases are
removed in core's next major, so this was a dated build break. The swap is
behaviour-free: `getDefaultStore` returns the same value, `undefined` included,
so the truthiness guard reads the same.

The same path published every file with a bare two-argument `saveFile`, leaving
`preventDuplicates` unspecified. It now passes `false` explicitly, because a CDN
publish is the one case where the key *is* the address: `main-hwqwrAvA.css` has
to land as `main-hwqwrAvA.css` or the name compiled into the HTML does not
resolve, and republishing an unchanged build has to overwrite in place rather
than leave a second copy behind under a different key.
