---
"@tapflowio/ios-agent": minor
---

Add audio output (device → browser) for the iOS simulator via macOS Core Audio process taps (macOS 14.2+). Opt-in via `TAPFLOW_IOS_AUDIO=1` (default off keeps the video path unchanged). Simulator apps are host processes, so the launched app's audio is captured with a per-process tap — no device routing, no dylib injection, no host-output hijack, and it works on any signed build. The capture runs in a small signed helper app (`audiotap-helper`) launched via LaunchServices so it holds its own one-time audio-recording permission grant; it normalizes to 44100/Stereo/S16 and streams to the agent over loopback TCP, reusing the existing `CODEC_AUDIO` transport.
