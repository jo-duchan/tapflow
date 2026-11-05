---
"@tapflowio/flow-runner": minor
"@tapflowio/mcp-server": minor
"@tapflowio/protocol": minor
"@tapflowio/relay": minor
"@tapflowio/ios-agent": patch
"@tapflowio/android-agent": patch
"tapflow": minor
---

Flows can turn the device (`setOrientation: portrait|landscape`) and fold it (`setPosture: folded|unfolded`). Both wait until the device reports the new state; a step the device cannot do ends as an environment failure, and a `--parallel` worker keeps the device. android-agent takes down the "Swipe up to continue" lock screen a fold puts up, unless the device was locked before or has a secure lock. The UI tree response carries `interfaceTurn` on iOS, read from the app by the tree runner, and `@tapflowio/protocol/screen` turns a point from the app's interface onto the device's portrait screen, so flow steps on an iOS app drawn in landscape land where the tree says.
