---
"@tapflowio/android-agent": patch
---

<!-- changelog: internal — screenshot warning strip moved into AdbWrapper; no observable change -->

The leading warning a multi-display device writes ahead of the PNG is now cut where the bytes are read, in `AdbWrapper.screenshot`, instead of in the MCP `screenshot:request` handler. Every consumer of a screenshot already went through that handler, so no user-visible behaviour changes.
