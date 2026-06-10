---
"tapflow": patch
---

fix(cli): doctor AVD is a failure (not a warning) when the SDK/emulator is absent

On a clean machine, `tapflow doctor` showed Android SDK/adb as ✗ but AVD as ⚠. AVD now mirrors iOS Simulator: a missing SDK/emulator is a failure (✗, `tapflow setup android`), while a present emulator with no AVD stays a warning (⚠). The emulator is resolved from the SDK directory.
