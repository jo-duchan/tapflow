---
"@tapflowio/ios-agent": minor
"@tapflowio/android-agent": minor
"tapflow": minor
---

Simulator audio output (device → browser) is now **on by default** for both iOS and Android. Opt out with `TAPFLOW_AUDIO=off` — one env for both platforms (`agent start --ios/--android` already selects the platform). The no-degradation contract (audio yields to video) keeps the video path safe whether audio is on or off.

**iOS**: simulator processes are host processes, so tapflow taps the whole simulator's process tree with a Core Audio process tap (macOS 14.2+) — app audio + WebKit `WebContent` (web audio, e.g. YouTube in Safari) + system sounds, with no device routing, no dylib injection, no host-output hijack, on any signed build. The tap stays current as processes spawn and start/stop audio (process-tree polling + a Core Audio process-object listener); each simulator is isolated (no cross-bleed); the sim's own volume is reflected; and the host (agent Mac) stays muted so audio goes only to the browser. The audio-capture permission is primed at `tapflow agent start` — re-run it if browser audio is silent.

**Android**: emulator audio is captured over gRPC `streamAudio`. Unlike iOS, the emulator also plays to the host Mac (it has no host-output-only mute) — use the Mac's own volume to silence it.

Capture normalizes to 44100/Stereo/S16 and rides the existing `CODEC_AUDIO` transport. The capture runs in a small signed helper (`audiotap-helper`, iOS) launched via LaunchServices so it holds its own one-time audio-recording grant.
