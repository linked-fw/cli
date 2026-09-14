---
summary: Portable static source-analysis contract, optional manifest validation, supported evidence and explicit limits.
---

# Static source analysis

Import `@_linked/cli/source-analysis/index`, not the CLI root. This subpath is
backend/build tooling: it parses supplied bytes and never loads an inspected
application, discovers a config file, executes a decorator, or writes a file.
It is not a browser dependency.

The host provides a `SourceSnapshot` and `AnalysisProfile`. The snapshot contains
module bytes/hashes, explicit import-resolution edges, selected public exports,
the existing Linked declaration graph (subjects, predicates, typed terms and
provenance), and a resolution fingerprint. The profile supplies supported
conditions, bounded work limits, and trusted Linked API module/export identities
attested against exact module hashes. These are privileged host inputs, not
claims accepted from an untrusted project or manifest.

`analyzeSource(snapshot, profile)` returns immutable evidence and per-claim
findings. Input objects are not frozen or mutated. The API recognizes explicit
named/default/re-export routes, Linked package decorator bindings, declared
namespace terms, class inheritance, literal/object properties, deferred
package/export ranges and the supported TypeScript decorator-helper output.
It does not treat a matching local function name as a Linked API.

Source identity, target-class identity and a public export are different things.
Multiple shapes may target one class. This module does not pick a registration
route from a filename or select the first target-class match. A deferred
package/export range is evidence of the declaration, not proof of its eventual
installed module route; the host/query-closure adapter must prove that route.

`coverage: partial` retains independently proved outer facts. Named findings
cover ambiguity, unrecognized syntax/helpers, changed bindings, missing imports,
unsupported paths/ranges and budgets. Inspection evidence never grants edit,
publish or data-migration authority. Invalid snapshots/profiles throw
`AnalysisRefusal`; hosts translate these into their normal refusal model.

`createManifest` and `serializeManifest` are deterministic data producers.
`validateManifest` supports absent, stale and unsupported manifests by returning
source-derived evidence. A fresh manifest contradicting source is refused, with
both the observed evidence and a diagnostic. **This first implementation
rederives claims for validation; it does not claim a performance acceleration.**
Safe subset acceleration can be added without changing the contract.

No build hook, filesystem observer, Git connection or automatic package install
is supplied by this module. A normal build producer may publish JSON at the
explicit package data export `./linked.source-analysis.json`. Never insert that
export while merely scanning someone else's package. Portable IDs cannot be
absolute/escaping machine paths; no CN working metadata or session belongs in
a distributed manifest.

Tests:

```sh
yarn test:unit --runInBand --runTestsByPath tests/unit/sourceAnalysis.test.ts tests/unit/sourceManifest.test.ts
yarn build
```
