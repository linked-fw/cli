---
'@_linked/cli': patch
---

`linked build-all` keeps building after a failure. A package whose build fails no longer stops the run when other packages depend on it: its dependents (direct and transitive) are skipped and reported as "not built because <package> failed", every package that does not depend on it is still built, and the run ends with one summary listing what was built, what failed and what was not built, then exits 1. A run where everything builds still exits 0. A dependency cycle that leaves packages unbuilt now also exits 1.
