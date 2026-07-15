# Uploading Builds

Upload iOS or Android builds so your team can test them.

## Dashboard upload

In App Center, click **Upload Build** and select your file.

- iOS: `.app.zip` or `.tar.gz`/`.tgz` — a simulator build. Build `.app.zip` [from the command line](https://developer.apple.com/library/archive/technotes/tn2339/_index.html), or upload a `.tar.gz` simulator build as-is.
- Android: `.apk`

::: warning iOS — `.ipa` files are not supported
`.ipa` is the format for real devices. tapflow accepts `.app.zip` and `.tar.gz` for simulators. If you get an upload error, see [Troubleshooting](/guide/troubleshooting#ios-build-upload-errors).
:::

On upload, the build is linked to an App by bundle ID. If no matching App exists, one is created automatically. You can also create the App first and link builds to it later.

For CI/CD uploads — automatic builds from your pipeline — see [Build Distribution](/guide/build-distribution).
