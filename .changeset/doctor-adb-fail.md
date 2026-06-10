---
"tapflow": patch
---

fix(cli): doctor reports missing adb as a failure, consistent with Xcode

`tapflow doctor` now marks a missing adb as a failure (✗) — the same as a missing Xcode — instead of a warning, so a clean machine shows its checks uniformly. `tapflow setup android` resolves it.
