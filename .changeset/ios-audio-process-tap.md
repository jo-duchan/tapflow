---
"@tapflowio/ios-agent": minor
"tapflow": minor
---

Add audio output (device → browser) for the iOS simulator via macOS Core Audio process taps (macOS 14.2+). Opt-in via `TAPFLOW_IOS_AUDIO=1` (default off keeps the video path unchanged).

Simulator processes are host processes, so tapflow taps the whole simulator's process tree per-process — capturing app audio, WebKit `WebContent` (web audio, e.g. YouTube in Safari), and system sounds — with no device routing, no dylib injection, no host-output hijack, on any signed build. The tap set is kept current as processes spawn and start/stop audio (process-tree polling + a Core Audio process-object listener). Each simulator is isolated, so concurrent simulators keep independent audio and volume, and the simulator's own volume (`sim_volume`) is reflected in the captured stream.

Capture runs in a small signed helper app (`audiotap-helper`) launched via LaunchServices so it holds its own one-time audio-recording permission grant, normalizes to 44100/Stereo/S16, and streams to the agent over loopback TCP on the existing `CODEC_AUDIO` transport. `tapflow setup ios` primes that permission up front, so an unattended agent operator grants it during setup rather than at first boot.
