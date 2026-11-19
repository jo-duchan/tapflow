---
"@tapflowio/ios-agent": patch
"@tapflowio/protocol": patch
"@tapflowio/relay": patch
"@tapflowio/flow-runner": patch
---

Flow Capture's keyboard read on an app that has no process (installed and not yet opened, the person on the home screen) is answered "not in front" once the app is 50 ms late, by asking for its process then, instead of after the 1.5 s deadline. Reads on the home screen took about 2 s, longer than a person takes between two taps there, so the default range kept the home-screen taps made before opening the app from its icon. The tap that opened the app is now left out too: iOS's touch report carries the touch's number in the app's process (`TouchObservation.seq`, optional), and a tap no app reported is taken for the icon's only when the next touch is the app's first; a touch the app reported is always in the app.

<!-- changelog: internal — Flow Capture is unreleased; this fixes a regression in it before release -->
