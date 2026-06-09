---
"tapflow": minor
---

feat(cli): add `tapflow doctor --json` and diagnose adb installed-but-not-in-PATH

- `tapflow doctor --json` emits machine-readable `{ ok, common, ios, android }` with no ANSI color, exiting 1 on failure — usable from CI and automation without screen-scraping.
- `doctor` now detects adb present in a standard SDK location (`$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`) but missing from PATH, instead of silently dropping the entire Android section. It surfaces an `adb (not in PATH)` warning hinting `tapflow setup android`.
