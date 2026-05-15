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

## `tapflow start`

Start the relay and iOS agent together.

```sh
tapflow start [options]
```

| Option | Description |
|--------|-------------|
| `--device <name>` | Simulator name or UDID (default: first booted) |
| `--relay <url>` | Connect to an existing relay instead of starting a local one |

---

## `tapflow doctor`

Diagnose environment issues.

```sh
tapflow doctor
```

Checks: macOS, Xcode, xcrun simctl, booted simulator, Node.js version.

---

## `tapflow devices`

List available simulators.

```sh
tapflow devices
```

---

## `tapflow boot`

Boot a simulator by name or UDID.

```sh
tapflow boot "iPhone 16 Pro"
tapflow boot 822F00B0-D9CF-4B78-8EDD-6322974E4079
```

---

## `tapflow reset`

Shut down all simulators.

```sh
tapflow reset
```

---

## `tapflow status`

Show connected agents, devices, and active sessions.

```sh
tapflow status [--relay <url>]
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
tapflow logs [--relay <url>] [--lines <n>]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--relay` | `http://localhost:4000` | Relay URL |
| `--lines` | 100 | Number of log lines to show (max 500) |
