---
"@tapflowio/relay": patch
"@tapflowio/ios-agent": patch
---

Flow Capture reads the field typed into and where the on-screen keyboard is on a Mac over its memory limit too: no agent starts anything on the Mac to answer, so the memory gate only lost typing and step pictures. The unreleased `recorded` hint on `device:boot` is removed; the iOS agent observes by `observed` alone.

<!-- changelog: internal — field and keyboard reads and `recorded` are unreleased (not in v0.32.0); the Unreleased "Added" entry is edited to drop the memory-limit sentence -->
