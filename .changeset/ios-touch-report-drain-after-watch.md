---
"@tapflowio/ios-agent": patch
---

<!-- changelog: internal — no user-reachable path: the watch's teardown always clears the device's reports (stopTouches) and the next watch is set before reports are written; the drain only crossed tests sharing a spied AppObserver. -->

The iOS agent's touch-report waits stop reading once the device's watch has ended, instead of reading once more after a disconnect or shutdown.
