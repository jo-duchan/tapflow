---
"tapflow": minor
---

feat(cli): setup android bootstraps a self-contained SDK (JDK + cmdline-tools), no Android Studio

`tapflow setup android` no longer relies on Android Studio (whose `.app` install doesn't include the SDK, breaking unattended setup). Instead it builds a self-contained SDK at `~/Library/Android/sdk`:

- installs a JDK via Temurin when missing (required by sdkmanager)
- bootstraps `cmdline-tools;latest` + `platform-tools` + `emulator` + a `google_apis` system image into the SDK with `sdkmanager --sdk_root`, auto-accepting licenses
- registers `ANDROID_HOME` and platform-tools/emulator on PATH
- creates the form-factor AVD set with the SDK's own avdmanager

Because cmdline-tools live inside the SDK, the avdmanager resolves the SDK root automatically — fixing the "Valid system image paths are: null" failure caused by a brew/SDK path split. Verified end-to-end on a clean Mac.
