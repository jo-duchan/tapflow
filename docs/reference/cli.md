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

---

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

---

## `tapflow start`

Start the relay and all available agents. Auto-detects iOS and Android based on your environment.

```sh
tapflow start
```

| Option | Description |
|--------|-------------|
| `--platform <ios\|android\|all>` | Platform to start (default: auto-detect) |
| `--device <name>` | iOS Simulator name or UDID (default: first booted) |
| `--relay <url>` | Connect to an existing relay instead of starting a local one |

---

## `tapflow doctor`

Diagnose environment issues.

```sh
tapflow doctor
```

Auto-detects available platforms and checks only what's relevant:

- **Common**: Node.js version
- **iOS** (macOS only): Xcode, xcrun simctl, booted simulator
- **Android** (if `adb` is in PATH): adb path, running AVD

---

## `tapflow devices`

List available simulators.

```sh
tapflow devices
```

---

## `tapflow boot`

Boot a simulator or AVD by name. Searches iOS simulators first, then Android AVDs.

```sh
# iOS
tapflow boot "iPhone 16 Pro"
tapflow boot 822F00B0-D9CF-4B78-8EDD-6322974E4079

# Android (AVD name)
tapflow boot Pixel_8
```

Android AVDs start in the background. Run `tapflow devices` to check status.

---

## `tapflow reset`

Shut down all simulators and emulators.

```sh
tapflow reset
```

---

## `tapflow status`

Show connected agents, devices, and active sessions.

```sh
tapflow status
```

Example output:

```
  ● mac-mini-office
      ◉  iPhone 16 Pro   ← qa@company.com
      ○  iPhone 15

  1 agent(s) · 2 device(s) · 1 active session(s)
```

---

## `tapflow logs`

Show recent relay log entries (last 100 lines by default).

```sh
tapflow logs
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay` | `http://localhost:4000` | Relay URL |
| `--lines` | 100 | Number of log lines to show (max 500) |
