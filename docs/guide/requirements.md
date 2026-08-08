# Requirements

## Relay Server

- Node.js ≥ 22
- macOS or any server OS (the relay only routes traffic)
- ~512 MB RAM, 1 vCPU is sufficient

## Agent

The agent runs on macOS. iOS and Android can run together on the same Mac.

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

- macOS 26 (26.x)
- Xcode 26 (26.x) with iOS Simulator Runtime installed

::: tip Newer versions
When a new major version (e.g. Xcode 27) is released, supporting it is our top priority. Until that support lands, please stay on the verified versions above.
:::

### Android

- Android SDK (`adb` in `$PATH` or `ANDROID_HOME` set)
- An AVD using `google_apis/arm64-v8a` system image (android-34)

## Dashboard

- Any modern browser (Chrome, Firefox, Safari, Edge)
- No extensions or plugins required

::: tip When using Tailscale tunnel
Every device that needs dashboard access must have Tailscale installed. → [Tailscale setup](/guide/self-hosting#tailscale-recommended)
:::
