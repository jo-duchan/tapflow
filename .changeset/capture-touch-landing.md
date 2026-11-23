---
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
"@tapflowio/android-agent": patch
"@tapflowio/flow-runner": patch
---

Flow Capture knows where each recorded touch went down on Android (`capture:landed`, #1214): the app, the home screen, a system surface, a prompt the app raised, or another app. The default range keeps a permission prompt answered before a trip home and a sheet another app showed as the app opened, and still skips the Google feed. iOS follows.
