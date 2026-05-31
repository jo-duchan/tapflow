# Scaling Mac Resources

tapflow scales horizontally — add more Mac hosts to the same relay to expand your device pool. Each Mac runs its own agent and connects outbound to the relay, so no firewall changes are required.

::: warning Keep agents and the relay on the same internal network
The agent streams video frames to the relay continuously. The latency (RTT) between the agent Mac and the relay must stay low to avoid frame drops.

Within the same office building, agents and relay can be on different floors or VLANs — internal routing keeps RTT low enough. Placing agents on a different network across the internet significantly increases latency and causes frame drops.
:::

See [Introduction — How it works](/guide/introduction#how-it-works) for a diagram.

## Adding a second Mac

::: tip The relay must be reachable from all Macs
When running `tapflow agent start` on another Mac, `ws://localhost:4000` resolves to that Mac's own localhost — not the relay machine. Use the relay's local IP address (`ws://192.168.x.x:4000`). Agents must stay on the same internal network as the relay — see [Self-Hosting the Relay](/guide/self-hosting) for network requirements.
:::

On the new Mac, install tapflow and point it at your existing relay:

```sh
npm install -g tapflow
tapflow agent start --relay ws://192.168.x.x:4000
```

That's it. The new Mac registers itself and its devices become visible in the dashboard immediately.

## Agent names

Each agent uses the Mac's hostname as its display name in the dashboard. To see which agent is which:

```sh
tapflow status
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
tapflow status
```
