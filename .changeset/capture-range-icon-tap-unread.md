---
"@tapflowio/flow-runner": patch
"@tapflowio/relay": patch
---

Flow Capture's default range leaves out the tap on the app's icon even when the person moved faster than the keyboard reads and none placed that tap, as long as the step before it was on the home screen and the app reports the next touch as its first (#1224).
