---
"@tapflowio/protocol": minor
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"@tapflowio/relay": minor
"@tapflowio/flow-runner": minor
---

Flow Capture's default range starts at the first step taken in the app when the app was opened from its icon, leaving out the home-screen swipes and taps that found it. `KeyboardState` gains `onHome`: on Android, whether the window the keyboard would type into belongs to the device's home app (read from the same `dumpsys window InputMethod`, with the home package resolved once per device); on iOS, whether the app under test is not in front, from the runner's existing answer. The relay keeps reading after an input while the home screen is in front (every 500 ms, up to 20 reads), so the read before the first tap in a slow-starting app is not left saying home, and reads again once the agent reports an install, launch or clear-state done (`app:*-done`), since the read the command started answered about the screen before it. The Android agent resolves the home package again when a serial is bound to another emulator. `segment` marks each step with the last read before it, `defaultRange` skips only the home-screen steps straight after the clean start and stops at a step no read placed, and `no-launch-at-start` is not raised for a range that starts in the app.
