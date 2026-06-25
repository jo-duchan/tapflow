---
"@tapflowio/android-agent": patch
---

Fix concurrent Android emulators sharing one video stream. Each emulator now launches on, and connects to, its own gRPC port (discovered from the running emulator's `.ini`) instead of a fixed `8554`, which collided when more than one emulator ran on the same Mac and made every session show the first emulator's screen.
