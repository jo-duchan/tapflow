---
"@tapflowio/relay": patch
---

<!-- changelog: internal — Flow Capture is unreleased; this speeds up its Match and makes Verify's list follow the step running, nothing a released version shows -->
Flow Capture's Match no longer reads the screen before replaying a launch that nothing waits on: after the reset the app is not running, and that read went unanswered until its 15 s deadline on every Match. Verify's step list follows the step running while the reader is at its bottom, as Agent activity does.
