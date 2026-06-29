---
"@tapflowio/audiotap-helper": minor
"@tapflowio/android-agent": minor
"@tapflowio/ios-agent": patch
---

Symmetric host-mute for Android (#341): the emulator's audio no longer leaks to the agent Mac's speakers.

The macOS Core Audio process-tap helper is now a shared package, `@tapflowio/audiotap-helper` (moved out of `ios-agent`), used by both platforms — so android-agent depending on it is a clean direction (no cross-platform-agent dependency). On macOS 14.2+, android-agent holds a **mute-only** `.muted` tap on the emulator's qemu process, silencing its host output while gRPC keeps capturing for the browser — matching iOS's `muteBehavior=.muted`. The helper self-exits when qemu dies; below 14.2 / non-macOS it's a no-op (fall back to the Mac's volume). `tapflow agent start` / `start` now also prime the audio-capture permission when Android is selected.

`ios-agent` keeps the same public API (`requestAudioPermission`/`isAudioSupported` are re-exported from the shared package); only the helper's internal location changed.
