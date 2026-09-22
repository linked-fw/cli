---
'@_linked/cli': patch
---

Drop `optimize-css-assets-webpack-plugin`, so `npm install` and `npm ci` work without `--legacy-peer-deps`.

The package declares `webpack ^5`, but this plugin's last release peers on
`webpack ^4`. npm cannot satisfy both, so a plain install failed outright:

```
npm error ERESOLVE could not resolve
npm error While resolving: optimize-css-assets-webpack-plugin@6.0.1
npm error Found: webpack@5.108.4
npm error Could not resolve dependency: peer webpack@"^4.0.0"
```

The workaround was `--legacy-peer-deps`, which silences every peer check in the
tree, not just this one — and it left `npm ci` broken, so a clean
lockfile-driven install never worked at all.

Nothing imports the plugin: it appears only in `devDependencies`, with no
reference anywhere in `src/`. It is also deprecated upstream in favour of
`css-minimizer-webpack-plugin`, which is not needed here either, since the
webpack config does not minify CSS through it.

Removing it is the whole fix. `npm install` and `npm ci` both succeed with no
flags, 28 fewer packages are installed, and the audit total drops from 20 to 19.
