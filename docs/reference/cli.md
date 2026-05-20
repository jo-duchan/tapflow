# CLI Reference

## Installation

::: code-group

```sh [npm]
npm install -g tapflow
```

```sh [yarn]
yarn global add tapflow
```

```sh [pnpm]
pnpm add -g tapflow
```

:::

To update:

```sh
npm update -g tapflow
```

## `tapflow init`

Create the first admin account on the relay. Only works when no accounts exist yet.

```sh
tapflow init
```

| Option | Description |
|--------|-------------|
| `--relay <url>` | Relay URL (default: `http://localhost:4000`) |

Example:

```
  ? Admin email: admin@yourteam.com
  ? Password: ********
  ✓ Admin account created
  →  Open http://localhost:4000 to sign in
```

Password must be at least 8 characters.


## `tapflow start`

**Local development shortcut.** Starts the relay and agent together on the same Mac.

```sh
tapflow start
```

| Option | Description |
|--------|-------------|
| `--platform <ios\|android\|all>` | Platform to start (default: auto-detect) |
| `--device <name>` | iOS Simulator name or UDID (default: first booted) |

::: info For team deployments
If you are running the relay on a separate server, use `tapflow relay start` and `tapflow agent start` instead.
:::


## `tapflow relay start`

Start the relay server only. Used when deploying the relay to a server.

```sh
tapflow relay start
```

| Option | Description |
|--------|-------------|
| `--port <n>` | Port (default: `4000`) |


## `tapflow agent start`

Start the agent only and connect it to a relay. Does not start a local relay.

```sh
tapflow agent start --relay wss://relay.myteam.example.com
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `ws://localhost:4000` | Relay WebSocket URL |
| `--platform <ios\|android\|all>` | auto-detect | Platform to start |
| `--device <name>` | first booted simulator | iOS Simulator name or UDID |


## `tapflow doctor`

Diagnose environment issues.

```sh
tapflow doctor
```

Auto-detects available platforms and checks only what's relevant:

- **Common**: Node.js version
- **iOS** (macOS only): Xcode, xcrun simctl, booted simulator
- **Android** (if `adb` is in PATH): adb path, running AVD

Exits with code `1` if any check fails.


## `tapflow devices`

List available simulators and emulators.

```sh
tapflow devices
```


## `tapflow boot`

Boot a simulator or emulator by name or UDID. Searches iOS simulators first, then Android AVDs.

```sh
# iOS
tapflow boot "iPhone 16 Pro"
tapflow boot 822F00B0-D9CF-4B78-8EDD-6322974E4079

# Android (AVD name)
tapflow boot Pixel_8
```

Android AVDs start in the background. Run `tapflow devices` to check status.


## `tapflow reset`

Shut down all simulators and emulators.

```sh
tapflow reset
```

A confirmation prompt is shown (`y/N`). Enter `y` to proceed.


## `tapflow status`

Show connected agents, devices, and active sessions.

```sh
tapflow status
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `ws://localhost:4000` | Relay WebSocket URL |

::: info How it connects
`tapflow status` connects to the relay over WebSocket to fetch information. Times out after 5 seconds if there is no response. Use the `--relay` option when connecting to a remote relay.
:::

Example output:

```
  ● mac-mini-office
      ◉  iPhone 16 Pro   ← qa@company.com
      ○  iPhone 15

  1 agent(s) · 2 device(s) · 1 active session(s)
```


## `tapflow logs`

Show recent relay log entries (last 100 lines by default).

```sh
tapflow logs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay <url>` | `http://localhost:4000` | Relay URL |
| `--lines <n>` | `100` | Number of log lines to show (max 500) |
