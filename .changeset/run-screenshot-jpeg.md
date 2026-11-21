---
"@tapflowio/android-agent": patch
"@tapflowio/flow-runner": patch
"tapflow": patch
"@tapflowio/relay": patch
"@tapflowio/mcp-server": patch
"@tapflowio/protocol": patch
---

`tapflow flow run` asks the device for JPEG screenshots, which the Android agent now makes with macOS `sips`, so a large screen's screenshot stays under the relay's 5 MB limit. A flow whose screenshot was still not kept says why on the Flow Runs page; the relay records it as `screenshotNote`.
