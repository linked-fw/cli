---
'@_linked/cli': patch
---

`linked build-all`'s end-of-run summary now shows, under each package that failed to build, a short excerpt of why: the lines of its output that look like errors (`error TS…` with file and line, `Error: …` with its first stack frame, `npm ERR!` lines that say something), without npm's lifecycle boilerplate, de-duplicated, truncated and capped at 8 lines, falling back to the last lines of output when nothing looks like an error. The full output is still printed inline when the failure happens; the excerpt makes the cause visible at the end without scrolling back through the interleaved parallel builds.
