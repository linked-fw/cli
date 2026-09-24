---
'@_linked/cli': patch
---

`create-ontology` no longer scaffolds a module that imports itself.

The generated ontology carried `import * as _this from './<prefix>.js'` and passed it
to `linkedOntology()`. That works under `tsc`, which preserves the self-reference, and
breaks under a bundler: Rollup treats it as a circular import and elides it, so the
binding is `undefined` at runtime and the consuming app dies at boot with
`_this is not defined` — a message pointing at neither the ontology nor the package.

Registration now lands in a sibling module, `<prefix>.register.ts`, where the same
import is ordinary:

```ts
import * as terms from './my-vocab.js';
import {linkedOntology} from '../package.js';
import {loadData, ns} from './my-vocab.js';

linkedOntology(terms, ns, 'my-vocab', loadData, '../data/my-vocab.json');
```

Existing ontologies keep working under `tsc` and should be migrated the same way before
they are bundled.
