---
"@tapflowio/android-agent": patch
---

A screenshot taken on a device with several displays is a PNG again: `screencap` writes a warning ahead of the image there, and the warning is cut from the bytes, so every consumer of a screenshot reads an image rather than text (#1118).

Which display was captured is still the device's choice; pinning it is a separate change.
