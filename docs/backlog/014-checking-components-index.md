---
summary: >
  A build check, `Checking components/index`, that every linked component a package's modules
  define is exported from `components/index`, so none is missing from `components.ttl`.
source: report 042 (Follow-ups), 29 Oct 2026
status: open
---

# 014 — Checking components/index

`linked build` indexes only the linked components exported from `src/components/index.ts`
(`Writing components.ttl`, report 042). A component defined in a module that the index does not
export is silently absent from the component index, so Create Now's builder never offers it.

**Idea.** A step `Checking components/index`, next to `Checking shapes/index`
(`src/utils/shapesIndex.ts` is the precedent): load each compiled module under
`lib/esm/components/` in a child, collect the linked components it exports (`.query` and
`.shape`), and report those the index does not export. Warning first, error later.

**Open:** whether components outside `components/` count; how a deliberately private component
opts out.
