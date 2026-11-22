---
"@tapflowio/android-agent": patch
---

<!-- changelog: internal — AdbWrapper takes its clock as a constructor parameter for its tests; no behaviour change -->

AdbWrapper counts the UI dump's time budget on a clock it is given, the real one by default.
