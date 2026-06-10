---
"tapflow": minor
---

fix(cli): `doctor` shows Android even without adb, and adds `doctor [platform]`

`tapflow doctor` no longer hides the Android section when adb is not found — it surfaces an `adb not found → tapflow setup android` warning so people setting up an Android-only agent can still diagnose it. Added `tapflow doctor ios|android` to check a single platform (mirrors `tapflow setup [platform]`); omit the argument to check all.
