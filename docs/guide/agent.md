# Agent Setup

The agent runs on a Mac and streams simulator and emulator screens to the relay. It connects outbound to the relay — no inbound firewall rules needed.

## Start the agent

When the agent and relay run on the same Mac, no flags are needed — the port is read from `tapflow.config.json` (default `4000`):

```sh
tapflow agent start
```

When the relay runs on a separate machine, pass its URL explicitly. `192.168.x.x` is the relay Mac's LAN IP:

```sh
tapflow agent start --relay ws://192.168.x.x:4000
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay` | `ws://localhost:[port]` | Relay WebSocket URL. Port is read from `tapflow.config.json`. |
| `--device` | first booted simulator | iOS Simulator name or UDID |

::: tip Keep the agent and relay on the same network
The agent streams video frames to the relay continuously. For the best streaming quality, run the agent and relay on the same Mac or the same LAN. Connecting across different networks increases latency and may cause frame drops.
:::

## iOS

### Prerequisites

- macOS
- Xcode with iOS Simulator Runtime installed
- Node.js ≥ 20

### List available simulators

```sh
tapflow devices
```

### Multiple simulators

Each Mac supports 2–4 simultaneous simulators depending on available RAM. The agent reports available slots automatically. See [Scaling Mac Resources](/guide/scaling) for details.

### Troubleshooting

```
Common
  ✓ Node v20.x

iOS
  ✓ Xcode 16.2
  ✓ xcrun simctl
  ✓ Simulator booted: iPhone 16 Pro
```

## Android

### Prerequisites

- Android SDK installed (`ANDROID_HOME` set or `adb` in `$PATH`)
- An AVD using the `google_apis/arm64-v8a` system image (android-34)

### Create an AVD

Create an AVD using Android Studio's AVD Manager. See [Create and manage virtual devices](https://developer.android.com/studio/run/managing-avds) for a step-by-step guide.

When selecting the system image, note the following:

::: warning AVD image matters
Use a `google_apis/arm64-v8a` image — the tested and recommended configuration. The `google_apis_playstore` image is not tested and has shown H.264 encoder issues.
:::

The agent boots the emulator automatically, waits for `sys.boot_completed`, then begins streaming. For emulators on Apple Silicon, the agent encodes H.264 on the Mac host (VideoToolbox), capped at 30 fps — no GPU load on the emulator itself.

### Troubleshooting

```sh
tapflow doctor
# Common
#   ✓ Node v20.x
#
# Android
#   ✓ adb found: /usr/local/bin/adb
#   ✓ AVD: Pixel_8 (android-34 · google_apis/arm64-v8a)
```

See [Troubleshooting](/guide/troubleshooting) for more detailed solutions.

## Stream quality

tapflow streams in one of three profiles. You don't choose it — the agent picks the profile from how each viewer connects, balancing resolution and decoder cost for that path.

| Profile | Connection | Resolution | Decoder | Experience |
|---------|------------|------------|---------|------------|
| **Standard** *(recommended)* | LAN over HTTP | 1280 px | WASM (tinyh264) | Near-localhost responsiveness |
| **Sharp** | LAN over HTTPS *(or localhost)* | Native | WebCodecs (hardware) | Localhost-grade |
| **Remote** | External over HTTPS | 1000 px | WebCodecs (hardware) | Usable QA threshold |

**Standard** is what most teams use day to day — a plain-HTTP relay on the LAN. The browser decodes H.264 with the software WASM decoder, so tapflow caps the resolution at 1280 px to keep decode load low while keeping responsiveness close to localhost.

**Sharp** is the best tapflow can offer. On a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) — HTTPS on the LAN, or localhost — the browser unlocks WebCodecs and decodes in hardware, so the agent sends native resolution at minimal CPU cost. To move a shared LAN from Standard to Sharp, **serve the relay over HTTPS** — see [Self-Hosting the Relay](/guide/self-hosting).

**Remote** covers viewers connecting from outside the LAN (a public IP). HTTPS keeps hardware decoding, but the resolution is trimmed to 1000 px because the link is bandwidth-constrained — enough for QA, at the edge of comfortable.

::: tip Why HTTPS unlocks hardware decoding
WebCodecs is only available in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Plain HTTP on the LAN is not secure, so the browser falls back to the WASM decoder — which is why **Standard** caps resolution and **Sharp** (HTTPS) doesn't.
:::

### Override environment variables

The profile is automatic, but you can override the resolution caps. Set these on the Mac running the agent.

| Variable | Default | Description |
|----------|---------|-------------|
| `TAPFLOW_MAX_SIZE` | *(per profile)* | Cap for all platforms (px, longest side). `0` forces native resolution on every connection. |
| `TAPFLOW_MAX_SIZE_LAN` | `1280` | Standard (LAN HTTP) cap. |
| `TAPFLOW_MAX_SIZE_EXTERNAL` | `1000` | Remote (external) cap. |
| `TAPFLOW_IOS_MAX_SIZE` | *(per profile)* | iOS-specific override. Takes precedence over `TAPFLOW_MAX_SIZE`. |
| `TAPFLOW_ANDROID_MAX_SIZE` | *(per profile)* | Android-specific override. Takes precedence over `TAPFLOW_MAX_SIZE`. |
