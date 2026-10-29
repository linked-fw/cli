---
summary: >
  `Removing old files from lib folder` deletes only files older than 120 seconds, so output of a
  source file deleted shortly before a rebuild survives it (and with it a stale shapes.ttl or
  components.ttl input).
source: report 042 (Follow-ups), 29 Oct 2026
status: open
---

# 015 — Stale lib files survive a rebuild within two minutes

`removeOldFiles` (`src/cli-methods.ts`) removes the files under `lib/` whose mtime is more than
120 s old. A source file deleted less than two minutes after the previous build keeps its compiled
output: deleting `src/components/index.ts` and rebuilding at once leaves
`lib/esm/components/index.js`, so `Writing components.ttl` still writes the index (seen in report
042's sandbox run; the same holds for `shapes/index` and `shapes.ttl`).

**Idea.** Remove the files of `lib/` that the current compile and copy did not write (a set
recorded during the build, or a stamp taken when the build starts) instead of an age threshold.
