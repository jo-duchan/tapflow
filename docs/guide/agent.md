# Agent Setup

The agent runs on a Mac and streams simulator and emulator screens to the relay. It connects outbound to the relay — no inbound firewall rules needed.

## Start the agent

When the agent and relay run on the same Mac, no flags are needed — the port is read from `tapflow.config.json` (default `4000`):

```sh
tapflow agent start
```

When the relay runs on a separate machine, pass its URL together with an auth token. `192.168.x.x` is the relay machine's LAN IP. See [Remote relay authentication](#remote-relay-authentication) for how to create the token:

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay` | `ws://localhost:[port]` | Relay WebSocket URL. Port is read from `tapflow.config.json`. |
| `--device` | all simulators | Limit which iOS simulators are exposed to the relay, by name or UDID |
| `--token` | none | Token with the `agent` scope for remote relay authentication. Can also be passed via the `TAPFLOW_AGENT_TOKEN` environment variable. |

::: tip Keep the agent and relay on the same network
The agent streams video frames to the relay continuously, so it must sit on the same LAN as the relay over a stable connection — **wired Ethernet is recommended**, Wi-Fi is fine if the signal is steady. Connecting across different networks, or over an unstable link, increases latency and causes frame drops.
:::

## Remote relay authentication

No authentication is needed when the agent connects to a relay on the same machine (`localhost`). When the relay runs on a different machine, it only accepts agents that present a token with the `agent` scope. This protects your sessions from an arbitrary device on the same network impersonating an agent and feeding screens into a test session.

The relay requires authentication on every connection that does not come from localhost — this section covers the agent side. For how browsers reach the relay from outside the office (tunnels), see [External access in Self-Hosting the Relay](/guide/self-hosting#external-access).

### Create a token

In the dashboard, go to **Settings → Tokens → New token** and set the Type to **Agent**. Only accounts with the Admin role can create `agent`-scope tokens. The success screen shows a ready-to-run agent command — copy it and run it on the agent machine.

### Pass the token

Pass it with the `--token` flag:

```sh
tapflow agent start --relay ws://192.168.x.x:4000 --token tflw_pat_xxxxxxxx
```

If you prefer to keep the token out of your shell history, use the `TAPFLOW_AGENT_TOKEN` environment variable. When both are set, the flag wins:

```sh
export TAPFLOW_AGENT_TOKEN=tflw_pat_xxxxxxxx
tapflow agent start --relay ws://192.168.x.x:4000
```

Connecting to a remote relay without a token (or with an expired or revoked one) makes the agent print the rejection reason along with the token setup steps, then exit.

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
  ✓ Xcode 26.0
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

Resolution and decoder are chosen automatically per viewer connection — tapflow streams in a **Standard**, **Sharp**, or **Remote** profile depending on how each viewer reaches the relay. See [Streaming Quality](/guide/streaming) for the profiles and how to tune them.
