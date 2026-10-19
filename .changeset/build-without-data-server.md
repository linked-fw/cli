---
'@_linked/cli': minor
---

`build-app` and `publish-app` load only the app's `linked.backend.files.{ts,js}` to find the `appAssets` store when the app has one, so a build no longer builds the dataset stores or needs the data server or Fuseki. An app without the file loads the whole storage file as before. The app template ships the file (app-template#34).
