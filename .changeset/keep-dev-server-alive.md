---
'@_linked/cli': patch
---

`linked start` no longer lets Vite restart its dev server when `.env` (or another env file, or `vite.config.*`) changes. The restart closed the SSR module runner the backend was loaded by, so every later `import()` in it failed with "Vite module runner has been closed." — `POST /admin/sync-shapes` among them — until the app was restarted. A change to those files now takes effect at the next `linked start`; a restart that happens regardless logs that the process must be restarted.
