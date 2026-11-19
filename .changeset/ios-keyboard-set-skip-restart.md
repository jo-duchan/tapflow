---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — the keyboard set and reset are Flow Capture's and the run reset's, both unreleased; this only skips work already done -->
Setting an iOS device's keyboard language leaves the keyboard daemon alone when the device is already in that language. Flow Capture's Match set it right after the run reset had restarted the daemon, and a second restart in a row took about 10 s; it now takes under a second when nothing changes.
