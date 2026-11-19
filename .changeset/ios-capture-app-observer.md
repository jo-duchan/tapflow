---
"@tapflowio/ios-agent": patch
"@tapflowio/relay": patch
---

Capture my steps no longer makes an iOS app lag. The agent read the soft keyboard and the focused field through an XCUITest runner, warmed at the boot of every person it recorded, and an attached runner made a busy SwiftUI app visibly stutter even with no query running. These reads now come from inside the app under test, through the injected library the network control already loads (no accessibility client, 3–4 ms a read); the runner starts only for a tree or reach query and is released after 30 s idle unless an automation client booted the device. A field in a web view, or one read while the app is not active, is reported as secure, so typing there becomes a secret. The relay's comments about warming are updated; its behaviour is unchanged.
