---
summary: The two package conventions that make a second copy of a framework module harmless — module state on globalThis via core's sharedState, errors matched by brand via isLinkedError — plus how React contexts and non-error class checks are handled, and where each package stands.
---

# Shared state and error brands

A framework module can be evaluated more than once in one runtime: under `linked start` once by
Vite's SSR module runner and once by Node ([report 017](../reports/017-dual-copy-e2e.md) has the
history), and in a browser when two bundles each carry a copy. The CLI removes the copies it knows
of. These conventions make a copy that still happens harmless instead of silently wrong.

Both helpers are in `@_linked/core` (2.36.0 and later), which every package depends on. The
convention is the `Symbol.for` keys, not the helper: two copies of core read and write the same keys.

## 1. Module state lives on `globalThis`

A module-level value that more than one caller writes or reads is kept with `sharedState`:

```ts
import {sharedState} from '@_linked/core/utils/sharedState';

const state = sharedState('@_linked/my-pkg', 'Mailer', () => ({
  provider: undefined as Provider | undefined,
}));
export function setProvider(p: Provider) { state.provider = p; }
```

`sharedState(pkg, name, init)` returns `globalThis[Symbol.for('<pkg>:<name>')]`, created by `init`
on first use. `pkg` is the npm name; `name` is unique within the package (the class or module it
belongs to).

- **What must be shared:** registries callers add to, configured singletons and setters
  (`setX`, `setDefaultX`, `configureX`), statics callers assign (`Cls.defaultHeaders = …`), event
  buses, logs that one caller writes and another reads, and process-wide side effects that must
  run once (wrapping `fetch`, `process.on`).
- **What stays per copy:** memo caches that can be rebuilt (or are keyed on a shared version),
  warn-once flags, lazy loaders, recursion guards, private class instances.
- **Keep the state in one container object and mutate its fields.** A primitive copied into a
  local is not shared.
- **Keep the public API.** A static that callers read or assign becomes a static getter/setter
  over the container (`static get defaultHeaders() { return state.defaultHeaders; }`).
- **The container outlives a version.** Two copies may be different versions. A newer copy that
  adds a field fills it in when it finds a container without it; it never assumes the layout.
- Classes stay per copy; only the state moves.

## 2. Errors are matched by brand, not `instanceof`

An error class that another package (or an app) may catch is branded once, after the class:

```ts
import {brandLinkedError} from '@_linked/core/utils/linkedError';

export class StoreError extends Error {}
brandLinkedError(StoreError, '@_linked/my-pkg', 'StoreError');
```

Code that catches an error from another package checks it with
`isLinkedError(err, StoreError)` (from `@_linked/core`). The brand is
`Symbol.for('<pkg>:<ClassName>')` on the prototype, read along the error's prototype chain, so it
matches an instance from any copy, and a subclass instance against its base. The name is passed
explicitly because a minifier may rename the class. An unbranded class falls back to `instanceof`;
a subclass is branded separately, it does not inherit its base's brand for the check.

A package that keeps an older `Cls.is(err)` (like `ServerCallError.is`) has it call
`isLinkedError` first and keep its old structural check for errors from a copy that predates the
brand.

## 3. React contexts

A context made with `createContext` at module level exists once per copy: a provider from one copy
is invisible to `useContext` in the other, and the consumer gets the default value with no error.
Keep the context object itself in shared state:

```ts
const {AuthContext} = sharedState('@_linked/auth', 'contexts', () => ({
  AuthContext: createContext<AuthState | null>(null),
}));
```

This holds while both copies share one React (the CLI dedupes React). Two Reacts cannot share a
context at all, and that is a resolution bug to fix, not to work around. `@_linked/server-utils`'
`AppContext` already does this by hand on `globalThis.__linkedAppContext`.

## 4. Class identity that is not an error

`instanceof Shape`, `ShapeSet`, `QueryBuilder`, `PendingQueryContext` and the like fail the same way
for a value made by another copy of core. `isLinkedError` covers errors only. The same brand,
generalised to `isLinkedInstance(value, Cls)`, is in core 2.36.2 (core
[report 039](https://github.com/linked-fw/core/blob/main/docs/reports/039-module-state-shared-across-copies.md)). Brand a class with
`brandLinkedClass(Cls, pkg, name)` right after its declaration.

## Where the packages stand

From a survey of every `@_linked/*` package's `src/` (2026-10). Counts are must-share state /
`instanceof` sites on another package's classes / module-level React contexts.

| Package | Must-share | Cross `instanceof` | Contexts | Status |
|---|---|---|---|---|
| core | 14 | ~75 sites, 9 classes | 0 | done in 2.36.2: state shared, classes branded, `isLinkedInstance` ([report 039](https://github.com/linked-fw/core/blob/main/docs/reports/039-module-state-shared-across-copies.md)) |
| server-utils | 7 | 2 files (`Shape`, `ShapeSet`, `CoreSet`) | 1 (already shared) | done: state shared, `ServerCallError` branded (1.13.0); class checks use `isLinkedInstance` (1.14.1) |
| server | 3 settings + 2 process side effects | 2 (with name fallback) | 0 | done in 3.2.0: state shared, process setup once, errors branded |
| auth | 13 | 0 | 2 | done in 3.15.4 ([report 015](https://github.com/linked-fw/auth/blob/main/docs/reports/015-shared-state.md)) |
| translation | 3 | 0 | 1 | done ([report 001](https://github.com/linked-fw/translation/blob/main/docs/reports/001-state-a-second-copy-sees.md)) |
| react | 1 | 9 | 0 | done ([report 002](https://github.com/linked-fw/react/blob/main/docs/reports/002-class-checks-and-state-across-copies.md)) |
| shape-ui | 0 | 0 | 3 | done ([report 001](https://github.com/linked-fw/shape-ui/blob/main/docs/reports/001-shared-host-contexts.md)) |
| primitives | 1 (toast store) | 0 | 2 (compound, low risk) | done ([report 001](https://github.com/linked-fw/primitives/blob/main/docs/reports/001-toast-store-across-copies.md)) |
| schema | 1 (`MediaUploadPolicy`) | 0 | 0 | done ([report 001](https://github.com/linked-fw/schema/blob/main/docs/reports/001-media-upload-policy-across-copies.md)) |
| sentry | 0 (writes core's `LinkedErrorLogging`, shared since core 2.36.2) | 0 | 0 | — |
| fuseki | 0 (`FusekiQueryError` unbranded) | 0 | 0 | brand when touched |
| cli, s3, css, icons, dcat, dcmi, org, owl, rdfs, sioc, xsd | 0 | 0 | 0 | — |

Every package listed has moved. New code follows the conventions.
