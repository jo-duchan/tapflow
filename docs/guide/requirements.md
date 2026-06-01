# Requirements

## Relay Server

- Node.js ≥ 20
- macOS or any server OS (the relay only routes traffic)
- ~512 MB RAM, 1 vCPU is sufficient

## Agent

The agent runs on macOS. iOS and Android can run together on the same Mac.

- macOS
- Node.js ≥ 20

### iOS

- macOS 26 or later
- Xcode 26 or later with iOS Simulator Runtime installed

### Android

- Android SDK (`adb` in `$PATH` or `ANDROID_HOME` set)
- An AVD using `google_apis/arm64-v8a` system image (android-34)

## Dashboard

- Any modern browser (Chrome, Firefox, Safari, Edge)
- No extensions or plugins required

::: tip When using Tailscale tunnel
Every device that needs dashboard access must have Tailscale installed. → [Tailscale setup](/guide/self-hosting#tailscale-recommended)
:::
