---
"@tapflowio/protocol": minor
"@tapflowio/ios-agent": minor
"@tapflowio/relay": minor
---

Each recorded iOS touch report now carries iOS's own `tapCount`, and is followed by the app's verdict on the touch: `TouchObservation.acted`, true when a control the app listens to fired, an action was sent, a list selected a row or a gesture recogniser of the app's ended, from the touch-down until a second after the lift; false when none did; absent when that cannot be known (a web view, keyboard or Flutter touch, a drag, a cancelled touch, React Native, a view whose touch methods are the app's own, a verdict closed late, or an iOS missing one of the hooked methods). The agent matches the verdict to the touch by its sequence number and sends a second `capture:touched` for the gesture, which the relay and flow-runner keep in place of the first. A touch inside a web view is now reported as the `web` surface: on iOS 26.5 it lands on a plain view inside the web view, which the surface check missed. Nothing reads `acted` yet.
