---
"@tapflowio/android-agent": patch
---

The Android agent's log says why a UI tree read failed: the reason a read through the field server fell back, which request the field server left unanswered before it was restarted, and the error of a read that failed outright. The relay answers a failed read with a 502 and keeps no reason, so a stalled Flow Capture Match could not be explained from either log.
