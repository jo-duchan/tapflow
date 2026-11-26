---
"@tapflowio/ios-agent": patch
---

A paired touch's wait for the app's verdict stops reading touch reports once the device's watch has ended. A disconnect or shutdown during that wait (up to 3 s) read the reports once more after it, and drained ones meant for whoever watched the device next.
