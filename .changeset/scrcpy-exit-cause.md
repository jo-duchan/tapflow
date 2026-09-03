---
'@tapflowio/android-agent': patch
---

The Android agent's log now says why the scrcpy server exited. When the server process died the video socket closed and the stream restarted, and all the log showed was the restart. The exit code, or the signal, is recorded beside it, and an exit the agent asked for during teardown is not reported as a problem.
