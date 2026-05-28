# Scaling Mac Resources

tapflow scales horizontally — add more Mac hosts to the same relay to expand your device pool. Each Mac runs its own agent and connects outbound to the relay, so no firewall changes are required.

See [Introduction — How it works](/guide/introduction#how-it-works) for a diagram.

## Adding a second Mac

::: tip The relay must be reachable from all Macs
When running `tapflow agent start` on another Mac, `ws://localhost:4000` resolves to that Mac's own localhost — not the relay machine. Use the relay's actual network address: a local IP (`ws://192.168.x.x:4000`) for the same LAN, or a public URL for agents on different networks. See [Self-Hosting the Relay](/guide/self-hosting).
:::

On the new Mac, install tapflow and point it at your existing relay:

```sh
npm install -g tapflow
tapflow agent start --relay wss://your-relay-url
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

## Simulators per Mac

iOS Simulator and Android Emulator are memory-intensive. Each Mac can typically run 2–4 simultaneously depending on available RAM.

Simulators are booted and managed through the dashboard. The agent reports only booted simulators to the relay, so the team sees exactly what's available.

## Monitoring

Track CPU and RAM usage per agent from the **Mac Resources** tab in the dashboard.
Each host appears as a separate card with a time-series chart (1h / 6h / 24h / 7d).

For a quick CLI check:

```sh
tapflow status --relay wss://your-relay-url
```
