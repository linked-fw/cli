---
summary: >
  Two fleet-wide standards, written down as standards rather than as change logs: the
  emit-neutral tsconfig shape (three layers — identical everywhere, legitimately varying,
  accidental drift) and the build-script shape. Both are now in `defaults/package/` and the
  tsconfig one is locked by assertions in `tests/template/package.full.test.ts`. Records the
  `core` TS2550 root cause (`@types/node` v20 declared `Array.prototype.at()`, v24 does not — so
  `core` only ever typechecked because a dependency declared it, fixed with `lib`, never
  `target`), the `|| echo` that swallowed a failing `tsc` byte-identically in two repos, and five
  retractions — including that `tsconfig-cjs.json` is NOT dead and that `moduleResolution:
  "bundler"` does NOT strip `.js` from synthesized declarations.
---

# The tsconfig and build-script standards

Two sweeps over the `@_linked` fleet. They are one report because they share a shape: in each
case a *declaration* was present in every repo and *constrained nothing*, and in each case the
fix was to make the CLI's template the single source and lock it with a test.

This repository owns both, because `defaults/package/` is what every new package is born from.
The per-repo commits live in their own repos; what is durable is the standard.

---

# Part 1 — The tsconfig standard

## 1.1 What was audited

**22 of 25 checkouts have a `tsconfig.json`.** The three without are `css` (a pure-CSS package),
`lincd.org` and `localize` (no TypeScript build) — the CLI's build steps tolerate all three by
probing for the file rather than assuming it.

No repo uses `extends` or `references` in its **base** config. `extends` appears only in the
derived `tsconfig-esm.json` / `tsconfig-cjs.json`. That is deliberate and is now part of the
standard: **the base holds everything shared, the derived configs hold only what differs per
output format, and `rootDir` is inherited and never restated.**

## 1.2 The three layers

### Layer 1 — identical everywhere, and enforced

These are settings where a difference is a defect, not a preference.

| Setting | Value | Why it cannot vary |
|---|---|---|
| `rootDir` | `"./src"` | Without it TypeScript *infers* the root. Add one file outside `src/` and the emit silently becomes `lib/esm/src/index.js`, which breaks every path in `exports`. TypeScript 7 refuses to infer at all (`TS5011`). |
| `downlevelIteration` | **absent** | Removed in TS7 (`TS5102`), and already a no-op — every target in the fleet is ≥ es2015. |
| `moduleResolution: "node"` / `"node10"` | **absent** (template) | Removed in TS7 (`TS5108`). |
| `outDir` (esm) | `"lib/esm"` | It is what the `exports` map and `typesVersions` point at. |
| derived configs | `extends: "./tsconfig.json"` | One place to change. |

`sourceMap: true` is the only key literally present and equal in all 22 today.
`inlineSources: true` is 21 of 22, `declaration: true` 21 of 22, `experimentalDecorators` and
`esModuleInterop` 20 of 22.

### Layer 2 — legitimately varies, with the reason stated

Variation here is fine *provided the driver is named*. Unexplained variation is layer 3.

| Setting | Values | Driver |
|---|---|---|
| `jsx` | `"react"` (17) / `"react-jsx"` (3: icons, shape-ui, translation) | Which packages adopted the new JSX transform. Not React-vs-non-React — 20 of 22 declare a value. |
| `types` | `["node"]` (11), `+react` (3), `+react,react-dom` (5), `["node","jest"]` (core) | What the package's ambient surface genuinely needs. `core` typechecks its own tests. |
| `baseUrl` | `"./"` (libraries) / `"./src"` (cli, semantu-cli) | Library vs CLI. |
| `lib` | see §1.4 | Should be **explicit everywhere**; today only `core` and `translation` declare one. |

### Layer 3 — accidental drift, measured

Against the standard (`rootDir` pinned, no `downlevelIteration`):

> **On `origin/main`: 19 of 22 tsconfig-bearing repos match. Three do not — `sentry`,
> `server-utils`, `semantu-cli`.**

A correction worth stating plainly, because the round number is wrong and would have been
repeated: this is **not** "19 audited, 19 fixed". It is 22 audited, 19 conforming, 3 outstanding.
A local scan appears to show 14 of 22, but five of those misses (`dcmi`, `org`, `rdfs`, `schema`,
`xsd`) are **stale checkouts** 9–14 commits behind a merged `origin/main`, not real drift —
`git show origin/main:tsconfig.json` is the instrument, the working tree is not.

Remaining drift, itemised:

- `sentry`, `server-utils`, `semantu-cli` — no `rootDir`; the first two still carry
  `downlevelIteration`.
- `server-utils` — the only repo without `inlineSources`; it never received that commit.
- `skipLibCheck` absent in `dcat`, `fuseki`, `org`, `sentry`.
- `semantu-cli/tsconfig-esm.json` has `"outDir": "lib"`, not `lib/esm`, alone in the fleet.
- `sentry/tsconfig-es5.json` still exists.
- **Template and fleet disagree on `moduleResolution`.** The template test forbids `"node"`, but
  `cli`, `core`, `react` and `semantu-cli` keep it in their base configs and five repos keep it in
  their esm configs. In `core` this is *deliberate* — its commit says `moduleResolution` "has no
  emit-neutral replacement here", and `core`'s emit feeds shape identity. So the rule is: **new
  packages must not have it; existing ones need an emit-verified migration**, which is
  [backlog 004](../backlog/004-typescript-7-is-blocked-by-moduleresolution.md).

## 1.3 The template, and the test that locks it

`defaults/package/tsconfig.json` and `defaults/package/tsconfig-esm.json` now carry the standard
exactly: `rootDir: "./src"`, no `downlevelIteration`, `moduleResolution: "bundler"` in the derived
config, `outDir: "lib/esm"`.

It is locked by `tests/template/package.full.test.ts`, *"the tsconfigs have the fleet-standard
emit-neutral shape"* — which asserts each layer-1 rule, and crucially asserts the **consequence**
as well:

- `lib/esm/src/` must not exist. That is what actually breaks when `rootDir` is absent, and
  asserting the config alone would not catch an emit that went wrong for another reason.
- the scaffold is ESM-only: no `tsconfig-cjs.json`, no `lib/cjs`, no `require` condition, no
  `tsconfig-to-dual-package` devDependency.

Each rule carries its reason as a comment in the test, so the next person to "simplify" one reads
why it exists.

**Known gap:** that suite is gated behind `RUN_TEMPLATE_FULL=1` (it needs network and takes
minutes), so it does **not** run in the default pass. The lock is real but it is a lock somebody
has to turn.

## 1.4 The `core` TS2550, and why the fix was `lib` and not `target`

`core` used `Array.prototype.at()`. Its `target` is `es6`, which does not provide it. It
typechecked anyway, for years.

> `@types/node` **v20** shipped `compatibility/indexable.d.ts` — *"Polyfill for ES2022's `.at()`
> method on string/array prototypes"*. `@types/node` **v24** does not ship it.

Measured on one commit, changing nothing but the installed `@types/node`: v20.19.33 → clean;
v24.13.6 → five `TS2550: Property 'at' does not exist on type 'string[]'`. Independently
corroborated — the installed v24.19.0's `compatibility/` directory contains only
`iterators.d.ts`.

**`target` with no `lib` does not mean "that target's library types".** It means that target's
defaults *plus whatever any installed `@types` package happens to declare*. The ambient surface
was a function of the dependency tree rather than of the config, and a Renovate bump to a
`@types` package was therefore able to break a *typecheck* in a repo whose source had not changed.

The fix is one line — `"lib": ["ES2022", "DOM", "DOM.Iterable"]` — and the choice of knob is the
load-bearing part:

- **`target` was deliberately not raised.** `target` changes **emit**, and `core`'s emit feeds
  shape identity across the whole fleet. A shape-identity change from a typecheck fix would be
  the worst kind of regression: silent, downstream, and attributed to something else.
- **`lib` selects declaration files only** and is emit-neutral. Verified as such — `lib/` was
  built before and after and the trees diffed identical, under both `@types/node` 20 and 24.

**18 of 19 repos set a `target` and declare no `lib`**, so every one of them carries the same
latent hazard. That is hygiene rather than breakage — none is known to be failing today —
and it is [backlog 007](../backlog/007-target-drift-and-lib-declared-by-accident.md).

Two caveats recorded so nobody re-derives them: `core` still declares `"@types/node": "^20.12.7"`,
so the v24 bump has not landed there and the fix is pre-emptive; and its installed copy (24.19.0)
already disagrees with its lockfile (20.19.33), so the local tree is effectively running the v24
case already.

---

# Part 2 — The build-script standard

> **Superseded for the template.** `defaults/package/package.json` now builds with
> `"build": "linked build"`, the CLI's own pipeline (ESM compile, asset copy, specifier rewrite and
> the shape checks), and no longer carries `build-esm`, `copy-to-lib`, `rimraf` or `copyfiles`.
> Every linked package builds with `linked build`. The findings below still explain why a guarded
> `tsc` is wrong wherever a hand-written script remains.

## 2.1 The swallowed failure, in two repos, byte-identical

`auth` and `owl` both had:

```
"build-esm": "echo \"compiling ESM\" && rimraf ./lib/esm && (tsc -p tsconfig-esm.json || echo 'tsc returned non-zero; .js still emitted via noEmitOnError default')",
```

Compared as parsed JSON string values, not by eye: **identical in both repos, before and after.**
It was copy-pasted, not independently invented.

The excuse in the message is even true — `noEmitOnError` defaults to false, so `.js` *is* emitted.
It is true and irrelevant. What matters is the exit code: `|| echo` turns a non-zero `tsc` into a
zero, the wrapping `"build"` (`rimraf ./lib && npm run build-esm && npm run copy-to-lib`,
identical in both) carries on to `copy-to-lib`, and a package with type errors is published with
a green build.

This was not theoretical. Build logs from earlier the same day show `owl` reporting
`Found 4 errors in 2 files.` and the build proceeding into `copy-to-lib`.

**The standard:** `build-esm` is
`echo "compiling ESM" && rimraf ./lib/esm && tsc -p tsconfig-esm.json`, with no guard of any
kind. **18 repos share that value byte-for-byte today, and `grep -l "|| echo" */package.json`
returns nothing.**

`build` is `rimraf ./lib && npm run build-esm && npm run copy-to-lib` — **15 repos identical**.
The divergences all have a visible reason: `cli` appends `chmod-bin` because it ships a bin;
`icons` and `xsd` are still dual ESM+CJS; `core` and `react` have no assets to copy so they call
`tsc` directly; `css` is a pure-CSS no-op; `translation` delegates to `linked build`;
`semantu-cli` is yarn-based and not a `@_linked` package; `lincd.org` is an app; `localize` has
no compile step at all.

## 2.2 Dead weight removed

| Repo | Removed | Measured |
|---|---|---|
| `primitives` | compiled `.js` committed under `src/` | **48** |
| `dcat` | same | **7** |
| `sioc` | `src/custom-declarations.ts` | 9 lines; emit delta is exactly three files gone, everything else byte-identical |
| `s3` | dead `tsconfig-es5.json` | `lib/` byte-identical after (31 files), build 0, jest 0 |
| `auth` | dead `tsconfig-es5.json` | folded into the `|| echo` commit, not standalone |

The `src/*.js` files are not cosmetic: a consumer that resolves `@_linked/*` to workspace `src`
gets the stale `.js` shadowing the `.ts` beside it.

**Afterwards, no tracked `.js` under `src/` remains anywhere in the fleet except `localize`** —
which is legitimate, because it has no build step and those ten files are the source.

A methodology note, since the numbers are the kind that get mis-transcribed: 7 and 48 are the
counts *in the compiled-output commits*. A three-day window over all deletions gives 11 and 52,
because other commits also deleted files. Both numbers are correct answers to different questions.

`sentry` still has a `tsconfig-es5.json` —
Create Now's `docs/backlog/087-dead-tsconfig-es5-in-s3-and-sentry.md`, now one
repo rather than two.

---

# Retractions

The most useful part of the record. Each of these was believed, acted on or about to be acted on.

### R1 — `tsconfig-cjs.json` is **not** dead, and a sweep to delete it was stopped by measuring

A grep of `scripts` across every `package.json` finds `tsconfig-cjs` mentioned in **two** repos
(`icons`, `xsd`) out of the **14** that carry the file. Read as "12 orphaned files", which is
exactly how it reads, and a deletion sweep was authorised.

It is wrong, because **`npm run build` is not what CI runs — `linked build` is**, and
`linked build` probes for the file on disk with `fs.existsSync`, in two places
(`src/cli-methods.ts`: `compilePackageCJS`, and the "Dual package support" step). Both probes are
gated on `packagePublishesCjs(packageJson)`.

The intent is stated in that function's own doc comment (`src/package-manifest.ts`):

> Keyed on the manifest rather than on the presence of `tsconfig-cjs.json`, so a package opts out
> by describing itself honestly rather than by deleting a file.

Evaluated against every manifest: **3 repos genuinely publish CJS** — `icons`, `xsd` (both
conditions) and `sentry` (via `main: "lib/cjs/index.js"`, no `require` condition). For the other
11 both gates short-circuit and the file is inert.

So the file is live machinery for three repos and vestigial-but-harmless for eleven, and deleting
it is the wrong lever regardless: **the manifest is the switch.** The general lesson is the
familiar one — the grep measured the *script*, and the script is not what runs.

### R2 — `moduleResolution: "bundler"` does **not** strip `.js` from synthesized `.d.ts`

This premise was passed down twice. It is false, and falsifying it takes about a minute.

A two-file package compiled with `module: esnext`, `target: es2018`,
`moduleResolution: "bundler"`, `declaration: true`:

```
src/index.ts:  export * from './a.js';   import './a.js';
lib/index.d.ts: export * from './a.js';  import './a.js';
lib/index.js:   export * from './a.js';  import './a.js';
```

The specifier is preserved verbatim in both outputs. TypeScript does not rewrite module
specifiers under any `moduleResolution` — that has been true throughout, and `bundler` changes
how specifiers are *resolved*, not how they are emitted. Spot-checked against real fleet output
(`xsd/lib/esm/index.d.ts`), where every `.js` survives.

### R3 — `environmentMatchGlobs` does not exist in vitest 4.1.11

Not deprecated — **absent**. It appears nowhere in the installed package. The obvious fix for CN's
jsdom/`NODE_ENV` trap would have been silently ignored: an unknown key in a vitest config is not
an error, so the config would have looked correct and done nothing. The real mechanism is
`test.projects`.
Create Now's `docs/backlog/084-the-jsdom-node-env-trap-in-backend-tests.md`.

### R4 — "the sweep would produce a release to watch" — false, and the publish half is unverified

The expectation was that the fleet sweep would open a Changesets release PR that could be watched
end to end. It could not: **at the time of the sweep no repo had a pending changeset**, so there
was nothing for Changesets to version and no release PR could open.

That this sweep produced almost none is **correct, not an omission**: five of its six merged
changes (`auth`, `owl`, `dcat`, `primitives`, `s3`) change no published output — build scripts,
dead configs, and `src/*.js` that was never published. `sioc` does change published output, did
carry a changeset, and has been released.

**A second-order retraction, caught while writing this.** Re-measuring "pending changesets" by
listing `packages-local/*/.changeset/*.md` in the working trees returns **9**, in nine repos.
That number is wrong. Several of those checkouts are 9–14 commits behind a merged `origin/main`,
where the changeset has already been consumed by a release. Measured where it counts:

```
$ git -C <repo> ls-tree -r --name-only origin/main .changeset
```

> Across all 22 repos with a `.changeset/` directory, **`origin/main` holds exactly one pending
> changeset** — `translation/.changeset/exports-standard.md`.

The working tree is not the fleet. This is the same squash-merge/stale-checkout error as the one
in *State, and what is left*, reached by a different route within the same hour.

**What remains unverified is the publish half.** `linked build` on the release path is verified
live on four repos. An actual publish through the changed `publish.yml` has not happened. Nothing
here should be read as evidence that it works.

### R5 — the near-miss: a `TS5056` that looked exactly like a successful verification

To prove the `|| echo` fix bites, a type error was injected and the build re-run. In one repo the
error was appended to `src/index.ts` — but that repo's entry is **`src/index.tsx`**.

`owl/tsconfig.json` has both `"files": ["./src/index.tsx"]` and
`"include": ["./src/**/*.ts", "./src/**/*.tsx"]`, sharing one `outDir`. A newly created
`src/index.ts` is therefore picked up by the glob, and both inputs emit to `lib/esm/index.js`:

```
TS5056: Cannot write file … because it would be overwritten by multiple input files
```

**A non-zero exit — which is precisely what the verification was looking for, and which proves
nothing whatever about type errors.** Had it been accepted, the fix would have been recorded as
verified on the strength of a filename mistake.

Five repos have a `.tsx` entry (`dcmi`, `owl`, `rdfs`, `schema`, `xsd`), so the trap is live in
all of them. No stray `src/index.ts` exists anywhere today and all five working trees are clean.

**The honest limit of this one:** the mechanism is confirmed by reading `owl`'s tsconfig, and
`owl`'s commit message describes the error being injected into `src/index.tsx` (the right file),
consistent with the mistake having been caught and redone. But **there is no artifact** — no log,
no reflog entry, no scratch file — recording either the mistake or the corrected run. The claim
"proven to bite in each direction" rests on the commit messages' own assertion and nothing else.
Recorded as such rather than as verified.

---

# State, and what is left

**All six build-script branches are merged**, re-measured against `origin/main` rather than
against the local checkouts — which still show them as "1 ahead", because a squash merge leaves
the local branch commit unreachable from `main`. Comparing a working tree to its own upstream
branch would have reported six open branches needing PRs; it was wrong by exactly the width of a
squash.

| Repo | Change | Merged as | Verified on `origin/main` |
|---|---|---|---|
| `auth` | `\|\| echo` removed, `tsconfig-es5.json` deleted | `#60` | no `\|\| echo` in `package.json` |
| `owl` | `\|\| echo` removed | `#46` | no `\|\| echo` in `package.json` |
| `dcat` | 7 compiled `.js` removed | `#40` | 0 `.js` under `src/` |
| `primitives` | 48 compiled `.js` removed | `#60` | 0 `.js` under `src/` |
| `s3` | `tsconfig-es5.json` deleted | `#44` | file absent |
| `sioc` | `src/custom-declarations.ts` deleted | `#38` | file absent |

Still outstanding:

- **`sentry/tsconfig-es5.json`** still exists — the last one
  (Create Now's `docs/backlog/087-dead-tsconfig-es5-in-s3-and-sentry.md`).
- **`sentry`, `server-utils`, `semantu-cli`** are the three repos not yet on the tsconfig
  standard (§1.2 layer 3).
- **`server-utils`** has one uncommitted edit (`src/types/ShapeDetails.ts`) and is the only repo
  without `inlineSources`.
- **Nothing prevents the compiled-`.js` problem recurring** — `src/**/*.js` is not in any
  `.gitignore` nor in the template.
- **The template lock does not run by default** (`RUN_TEMPLATE_FULL=1`).

Open follow-ups: [004](../backlog/004-typescript-7-is-blocked-by-moduleresolution.md) (TS7 and
`moduleResolution`), [005](../backlog/005-published-shapesindex-breaks-the-react-native-template-test.md),
[006](../backlog/006-css-module-ambients-in-packages-that-import-no-css.md),
[007](../backlog/007-target-drift-and-lib-declared-by-accident.md) (`lib` in the remaining 17).
A single pass over the template can settle 004, 006, 007 and the `.gitignore` gap together.
