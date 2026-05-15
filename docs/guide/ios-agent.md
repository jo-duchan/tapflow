# iOS Agent Setup

The iOS agent runs on a Mac and streams simulator screens to the relay.

## One-time setup

```sh
tapflow ios setup
```

This command:
1. Detects your Xcode SDK version
2. Downloads the matching iOS Simulator Runtime if not already installed (~3 GB)
3. Downloads and builds WebDriverAgent for the simulator

You will be prompted for your Apple Team ID once during the WDA build step.

## Start the agent

```sh
tapflow agent start --relay wss://your-relay-url
```

The agent connects outbound — no inbound firewall rules needed.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--relay` | — | Relay WebSocket URL (required) |
| `--fps` | 30 | Target capture FPS |
| `--name` | `os.hostname()` | Name shown in the dashboard |

## Multiple simulators

Each Mac supports 2–4 simultaneous simulators depending on available RAM. The agent reports available slots automatically.

## Troubleshooting

Run `tapflow doctor` to diagnose common issues:

```
✓ Node.js 20.x
✓ Xcode 16.2
✗ WebDriverAgent — localhost:8100 not responding
    → Run: npx tapflow ios setup
```
