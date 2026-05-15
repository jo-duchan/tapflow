# iOS Agent Setup

The iOS agent runs on a Mac and streams simulator screens to the relay.

## Prerequisites

- macOS
- Xcode with iOS Simulator Runtime installed
- Node.js ≥ 20

## Start the agent

```sh
tapflow start --relay wss://your-relay-url
```

The agent connects outbound — no inbound firewall rules needed.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--relay` | — | Relay WebSocket URL |
| `--device` | first booted | Simulator name or UDID to use |

## List available simulators

```sh
tapflow devices
```

## Boot a specific simulator

```sh
tapflow boot "iPhone 16 Pro"
```

## Multiple simulators

Each Mac supports 2–4 simultaneous simulators depending on available RAM. The agent reports available slots automatically.

## Troubleshooting

Run `tapflow doctor` to diagnose common issues:

```
✓ macOS
✓ Xcode 16.2
✓ xcrun simctl
✓ Simulator booted: iPhone 16 Pro
✓ Node v20.x
```
