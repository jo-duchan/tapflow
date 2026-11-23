---
"@tapflowio/ios-agent": patch
"@tapflowio/flow-runner": patch
"@tapflowio/protocol": patch
---

Flow Capture knows where each recorded touch went down on iOS too (`capture:landed`, #1214), read from UIKit's dispatch log in the simulator's system log, with nothing injected: the app, the home screen, a system surface (status bar, Notification Center, Control Center, a banner), a prompt the app raised, Spotlight or another app. A device already running when the session began is read too. The default range now lets a landing outrank the reads, so another app's sheet that iOS reads as "not the app" stays when the app follows it.
