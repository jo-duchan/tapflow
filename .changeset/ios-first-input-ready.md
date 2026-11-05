---
"@tapflowio/ios-agent": patch
---

A boot announces `device:ready` once the touch helper it started can inject, up to 5 s, so a client acting on the device at once is no longer refused its first input as `channel-starting` (#1114).
