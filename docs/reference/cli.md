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

## `tapflow deploy`

Deploy the relay server to a cloud provider.

```sh
tapflow deploy
```

Supported providers: fly.io, AWS, GCP, self-hosted.

---

## `tapflow agent start`

Start an agent and connect it to a relay.

```sh
tapflow agent start --relay <url> [options]
```

| Option | Description |
|--------|-------------|
| `--relay` | Relay WebSocket URL (required) |
| `--fps` | Capture FPS (default: 30) |
| `--name` | Agent name shown in dashboard (default: hostname) |

---

## `tapflow ios setup`

Set up the iOS environment on a Mac (one-time).

```sh
tapflow ios setup
```

Downloads matching Simulator Runtime and builds WebDriverAgent.

---

## `tapflow upload`

Upload a build to the relay.

```sh
tapflow upload <file> --token <pat> [options]
```

| Option | Description |
|--------|-------------|
| `--token` | Personal Access Token (required) |
| `--relay` | Relay URL (default: read from config) |
| `--status` | Initial build status (default: Backlog) |

---

## `tapflow invite`

Send an invitation email to a new team member.

```sh
tapflow invite <email> [--role admin|developer|qa|viewer]
```

---

## `tapflow status`

Show connected agents, devices, and active sessions.

```sh
tapflow status --relay <url>
```

---

## `tapflow logs`

Tail relay logs (local relay process only).

```sh
tapflow logs [--lines 100]
```

---

## `tapflow doctor`

Diagnose environment issues.

```sh
tapflow doctor
```

---

## `tapflow reset`

Stop WDA and shut down all simulators.

```sh
tapflow reset
```
