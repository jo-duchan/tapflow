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
Use `google_apis/arm64-v8a` — **not** `google_apis_playstore`. The Play Store image causes the H.264 encoder to crash silently.
:::

The agent boots the emulator automatically, waits for `sys.boot_completed`, then begins streaming.

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
