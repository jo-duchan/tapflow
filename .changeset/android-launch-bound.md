---
"@tapflowio/android-agent": patch
---

Each Android app-launch command is now bounded on the host as well as on the device: the launcher lookup at 5 s, and `am start -W` or the monkey fallback at 12 s each, in sequence, so the launch as a whole is not bounded at 12 s. `am start -W`, bounded on the device by `timeout 10`, could hold the adb call for 30 s (measured), past Flow Capture's 30 s launch wait, which reported "app launch timed out" with the app on screen. A command cut on the host whose intent went out still counts as launched; a launch with arguments and `openUrl` are bounded the same way. A launch slower than 10 s is logged with where it waited.
