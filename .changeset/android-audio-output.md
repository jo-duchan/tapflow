---
"@tapflowio/android-agent": minor
---

Add audio output (device → browser) for the Android emulator. Opt-in via `TAPFLOW_ANDROID_AUDIO=1` (default off keeps the video path unchanged). Emulator audio is captured over the gRPC `streamAudio` path and carried on a separate envelope codec that yields to video, so it never affects the existing stream; the browser plays it via Web Audio with a sound on/off indicator in the device info card.
