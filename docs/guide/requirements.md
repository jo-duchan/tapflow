# Requirements

## Relay Server

- Node.js ≥ 20
- Any OS (Linux recommended for production)
- ~512 MB RAM, 1 vCPU is sufficient (the relay only routes traffic)

## iOS Agent

- **macOS** — required by Apple policy (iOS Simulator only runs on macOS)
- Xcode with iOS Simulator Runtime installed
- Node.js ≥ 20
- WebDriverAgent (installed via `npx tapflow ios setup`)

## Android Agent

- Linux, macOS, or Windows
- Android SDK (`adb` in `$PATH` or `ANDROID_HOME` set)
- An AVD using `google_apis/arm64-v8a` system image (android-34)
- Node.js ≥ 20

## Browser (QA team)

- Any modern browser (Chrome, Firefox, Safari, Edge)
- No extensions or plugins required
