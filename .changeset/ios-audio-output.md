---
"@tapflowio/ios-agent": minor
---

Add audio output (device → browser) for the iOS simulator. Opt-in via `TAPFLOW_IOS_AUDIO=1` (default off keeps the video path unchanged). `routeGuest`/SimulatorKit routing is a no-op on headless `simctl`-booted sims, so capture happens inside the guest app: an injected dylib taps the app's PCM at the CoreAudio source — per-simulator isolated, headless, and without hijacking the host's audio output. It covers AudioQueue apps and AVAudioEngine/AudioUnit apps (via the v2 mixer render), normalizes to 44100/Stereo/S16, and streams to the agent over loopback TCP, reusing the existing `CODEC_AUDIO` transport.
