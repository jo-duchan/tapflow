# Scaling Mac Resources

tapflow scales horizontally — add more Mac hosts to the same relay to expand your device pool. Each Mac runs its own agent and connects outbound to the relay, so no firewall changes are required.

## How it works

```
Browser (QA team)
    ↕ WebSocket
Relay Server
    ↕ WebSocket (outbound)          ↕ WebSocket (outbound)
Mac A (mac-mini-office)             Mac B (mac-mini-lab)
  ├── iOS Simulator × 3               ├── iOS Simulator × 3
  └── Android Emulator × 1           └── Android Emulator × 1
```

The dashboard shows all devices from all connected agents in a single list. QA picks any available device — tapflow routes the session to the right Mac automatically.

## Adding a second Mac

On the new Mac, install tapflow and point it at your existing relay:

```sh
npm install -g tapflow
tapflow start --relay wss://your-relay-url
```

That's it. The new Mac registers itself and its devices become visible in the dashboard immediately.

## Agent names

Each agent uses the Mac's hostname as its display name in the dashboard. To see which agent is which:

```sh
tapflow status --relay wss://your-relay-url
```

```
  ● mac-mini-office
      ○  iPhone 16 Pro
      ○  iPhone 15

  ● mac-mini-lab
      ○  iPhone 14
      ○  Pixel 8
```

The agent name is derived from the Mac's system hostname (`scutil --get ComputerName` on macOS). To change it, update the hostname in **System Settings → General → Sharing → Computer Name**.

## How many simulators per Mac?

iOS Simulator and Android Emulator are memory-intensive. As a guideline:

| RAM | Recommended slots |
|-----|-------------------|
| 8 GB | 1–2 iOS or 1 Android |
| 16 GB | 2–3 iOS or 1–2 Android |
| 32 GB | 4 iOS + 1–2 Android |

Boot only the simulators you need:

```sh
tapflow boot "iPhone 16 Pro"
tapflow boot "iPhone 15"
```

Then start the agent — it reports only booted simulators to the relay.

## Monitoring

Track CPU and RAM usage per agent from the **Mac Resources** tab in the dashboard.
Each host appears as a separate card with a time-series chart (1h / 6h / 24h / 7d).

For a quick CLI check:

```sh
tapflow status --relay wss://your-relay-url
```
