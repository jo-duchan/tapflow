---
"@tapflowio/ios-agent": patch
---

Flow Capture's keyboard read on an app that has no process (installed and not yet opened, the person on the home screen) is answered "not in front" once the app is 50 ms late, by asking for its process then, instead of after the 1.5 s deadline. Reads on the home screen took about 2 s, longer than a person takes between two taps there, so the default range kept the home-screen taps made before opening the app from its icon.

<!-- changelog: internal — Flow Capture is unreleased; this fixes a regression in it before release -->
