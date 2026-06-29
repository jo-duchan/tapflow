# @tapflowio/audiotap-helper

Shared macOS Core Audio process-tap helper for [tapflow](https://github.com/jo-duchan/tapflow).

Taps a host process's audio by PID — no device routing, no dylib injection, no host-output hijack. Used internally by `@tapflowio/ios-agent` (iOS simulator audio capture) and `@tapflowio/android-agent` (Android emulator host-mute). Ships as a prebuilt, ad-hoc-signed `.app` so it holds its own one-time audio-recording (TCC) grant.

## Requirements

- macOS 14.2+ (Core Audio process taps)
- Node.js ≥ 20

## Usage

Internal building block of tapflow — not intended for standalone use. The agents call it via the exported helpers:

```ts
import { ensureHelperApp, launchAudioHelper, launchMuteOnlyTap, isAudioSupported } from '@tapflowio/audiotap-helper'
```

See [contributing/simulator-audio.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/simulator-audio.md) for the design.

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.
