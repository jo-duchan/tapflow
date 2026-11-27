---
"@tapflowio/android-agent": patch
"@tapflowio/relay": patch
"@tapflowio/protocol": patch
---

MCP Flow Capture on Android names an agent's coordinate tap by what it hit. An AI client's tap is down and up back to back, so its up always beat the agent's read of what the down hit and the observation was always dropped. The relay now marks a machine holder's touch end (`RelayedTouchEnd.machine`), and an Android agent observing touches holds that tap's up in the emulator's touch queue until the read answers, at most 250 ms after the down. A person's tap, a drag or a fling is never held. Needs the relay and the Android agent from this release.
