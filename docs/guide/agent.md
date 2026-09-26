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
| `--relay` | `relay.url`, or `ws://localhost:[port]` | Relay WebSocket URL. Must start with `ws://` or `wss://`. When omitted, the agent uses `relay.url` from `tapflow.config.json` (or `TAPFLOW_RELAY_URL`), and falls back to `ws://localhost` on the configured port. If `relay.url` is an `http://` or `https://` address, the agent refuses to start, so pass `--relay` explicitly. |
| `--platform` | auto-detect | Platform to run: `ios`, `android`, or `all`. When omitted, every platform available on this Mac runs. |
| `--device` | all devices | Limit the agent to the devices whose name or ID matches. Works for iOS simulators and Android AVDs, and must match the name or ID exactly. |
| `--token` | none | Token with the `agent` scope for remote relay authentication. Can also be passed via the `TAPFLOW_AGENT_TOKEN` environment variable. |

::: tip Wired LAN recommended
Keep the agent and relay on the same wired LAN. Wi-Fi works but can stutter on a Mac (AWDL channel hopping), regardless of signal strength — see [Stream lag or stuttering](/guide/troubleshooting#stream-lag) for why and how to mitigate.
:::

## Remote relay authentication

No authentication is needed when the agent connects to a relay on the same machine (`localhost`). When the relay runs on a different machine, it only accepts agents that present a token with the `agent` scope. This protects your sessions from an arbitrary device on the same network impersonating an agent and feeding screens into a test session.

The relay requires authentication on every connection except one that reaches the relay port over loopback — this section covers the agent side. Reaching the same Mac by its LAN address counts as remote, and so does a tunnel client, which connects from loopback on someone else's behalf and therefore gets a separate tunnel port where every connection has to authenticate. For how browsers reach the relay from outside the office (tunnels), see [External access in Self-Hosting the Relay](/guide/self-hosting#external-access).

### Create a token

In the dashboard, go to **Settings → Tokens → New token** and set the Type to **Agent**. Only accounts with the Admin role can create `agent`-scope tokens, and a token stops working once the member who issued it is no longer an Admin or is removed from the team. Agents connected with it are disconnected at that moment, and a current Admin has to issue a new token. The success screen shows a ready-to-run agent command — copy it and run it on the agent machine.

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
- Node.js ≥ 22

### List available simulators

```sh
tapflow devices
```

### Multiple simulators

Each Mac supports 2–4 simultaneous simulators depending on available RAM. The agent reports available slots automatically. See [Scaling Mac Resources](/guide/scaling) for details.

### Troubleshooting

```
  ✓  Node v22.x
  ✓  Port 4000

  iOS
  ✓  Xcode 26.0
  ✓  xcrun simctl
  ✓  Simulator available (8)
  …
```

## Android

### Prerequisites

- Android SDK installed (`ANDROID_HOME` set or `adb` in `$PATH`)
- An AVD using the `google_apis/arm64-v8a` system image (android-35)

### Create an AVD

`tapflow setup android` creates four AVDs by form factor (`tapflow-compact`, `tapflow-phone`, `tapflow-large`, `tapflow-tablet`) from the android-35 `google_apis/arm64-v8a` image. See [Environment Setup](/guide/environment-setup). To create one yourself, use Android Studio's AVD Manager; see [Create and manage virtual devices](https://developer.android.com/studio/run/managing-avds) for a step-by-step guide.

When you create an AVD yourself, note the following about the system image:

::: warning AVD image matters
Use a `google_apis/arm64-v8a` image — the tested and recommended configuration. The `google_apis_playstore` image is not tested and has shown H.264 encoder issues.
:::

The agent boots the emulator automatically, waits for `sys.boot_completed`, then begins streaming. For emulators on Apple Silicon, the agent encodes H.264 on the Mac host (VideoToolbox), capped at 30 fps by default (change it with `TAPFLOW_ANDROID_FPS`) — no GPU load on the emulator itself.

### Troubleshooting

```sh
tapflow doctor
#   ✓  Node v22.x
#   ✓  Port 4000
#
#   Android
#   ✓  Android SDK: /Users/you/Library/Android/sdk
#   ✓  adb found: /Users/you/Library/Android/sdk/platform-tools/adb
#   ✓  aapt (build-tools): /Users/you/Library/Android/sdk/build-tools/35.0.0/aapt
#   ✓  AVD available: tapflow-compact
#   ✓  Lean mode (Android): off
```

See [Troubleshooting](/guide/troubleshooting) for more detailed solutions.

## Stream quality

Resolution and decoder are chosen automatically per viewer connection — tapflow streams in a **Standard**, **Smooth**, or **Remote** profile depending on how each viewer reaches the relay. See [Streaming Quality](/guide/streaming) for the profiles and how to tune them.

## Host display and sleep

While an agent is connected, it holds a macOS power assertion so the host doesn't sleep mid-session. By default it also keeps the display awake (`caffeinate -di`): when the display sleeps, macOS parks the GPU and throttles the simulator render and encoding, which shows up as a sluggish stream. Running an agent effectively dedicates the Mac to tapflow, so this is the default.

Set `TAPFLOW_ALLOW_DISPLAY_SLEEP=1` to let the display sleep normally (system sleep is still blocked).
