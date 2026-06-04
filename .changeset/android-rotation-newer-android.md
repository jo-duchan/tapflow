---
"@tapflowio/android-agent": patch
---

Fix Android screen rotation on Android 15+ (API 35+). `AdbWrapper.setRotation` now uses `wm user-rotation lock` instead of the legacy `settings put system user_rotation`, which is silently ignored on newer Android (only a rotation suggestion appears). The bundled scrcpy server is upgraded 3.1 → 3.3, which fixes the locked capture-orientation direction (scrcpy #6010) that left the stream sideways after rotation on API 35+. Verified on API 34 and API 36 emulators.
