---
"@tapflowio/android-agent": patch
---

An Android app launch is answered within 12 s: the launch's `am start -W`, bounded on the device by `timeout 10`, could hold the adb call for 30 s (measured), past Flow Capture's 30 s launch wait, which reported "app launch timed out" with the app on screen. The launch and the launcher lookup are now also bounded on the host, and a launch cut there whose intent went out still counts as launched. A launch slower than 10 s is logged with where it waited.
