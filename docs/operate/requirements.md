# Requirements

## Relay Server

- Node.js ≥ 22
- macOS or any server OS (the relay only routes traffic)
- ~512 MB RAM, 1 vCPU is sufficient

## Agent

The agent runs on macOS. iOS and Android can run together on the same Mac. For Android alone, it can also run on Windows ([Windows](#windows)).

- macOS on **Apple Silicon** (M-series)
- Node.js ≥ 22

::: warning Intel Macs are not supported
The agent ships native helper binaries built for arm64 only, so an Intel (x86_64) Mac cannot run them.
Opening a build fails with a generic `spawn unknown error`.

Apple Silicon is what tapflow has been developed and verified against. Intel support is possible and
tracked in [#464](https://github.com/jo-duchan/tapflow/issues/464), but it is not scheduled — it needs
a universal build plus verification on hardware the maintainers do not have.

The relay has no such constraint. Only the machine running the **agent** needs Apple Silicon.
:::

### iOS

- macOS 26 (26.x) or 27 (27.x)
- Xcode 26 (26.x) or 27 (27.x) with iOS Simulator Runtime installed

::: tip Newer versions
When a new major version (e.g. Xcode 28) is released, supporting it is our top priority. Until that support lands, please stay on the verified versions above.
:::

### Android

- Android SDK (`adb` in `$PATH` or `ANDROID_HOME` set)
- An AVD using `google_apis/arm64-v8a` system image (android-35)

### Windows (Android only) {#windows}

If you use only Android emulators, the agent can also run on Windows. This is community-supported: it was added by an outside contribution, and the maintainers do not test on Windows.

- `tapflow doctor` looks for the Android SDK in `ANDROID_HOME` and in `%LOCALAPPDATA%\Android\Sdk`.
- `tapflow setup android` works only on macOS. On Windows, set up the Android SDK and an emulator (AVD) yourself.
- iOS simulators run only on macOS.
- On an x86_64 PC, the AVD needs an `x86_64` system image rather than `arm64-v8a`.
- Booting and streaming an emulator on Windows has not been verified yet. What has been is that `tapflow doctor` finds the SDK and the AVDs, and that `tapflow start` serves the relay and the agent registers.

## Dashboard

- Any modern browser (Chrome, Firefox, Safari, Edge)
- No extensions or plugins required

::: tip When using Tailscale tunnel
Every device that needs dashboard access must have Tailscale installed. → [Tailscale setup](/operate/external-access#tailscale-recommended)
:::
