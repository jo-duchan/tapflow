---
type: rationale
topics: [relay, deployment, tunnel]
status: stable
---

# Why the relay stays inside the agent's network, with tunneling as opt-in

> Read this before proposing a cloud-hosted relay, or before wiring a tunnel into the relay
> core. The relay is deliberately co-located with the agent, and tunneling is a plugin the
> relay does not know about.

## The constraint

The one hard requirement is a low round-trip between relay and agent. It does not have to be
the same Layer 2 LAN; same-building L3 routing (about 1-5ms) is fine. The browser → relay leg
can be slower because frame drops absorb it. A cloud-hosted relay is therefore not viable:
it puts the agent → relay leg across the internet, which is the one leg that must stay fast.

## The two deployment shapes

- **LAN (default).** Browser, relay, and agent on the same internal network. No extra setup,
  local-simulator-class latency, and the browser must be on that network.
- **VPS + tunnel (external access).** The relay Mac opens an outbound tunnel to a VPS, so the
  browser reaches a public URL with no install and CGNAT does not matter. Data still flows
  through the operator's own VPS, which keeps the "nothing leaves your network to a third
  party" principle. The two shapes coexist: office users hit the LAN IP, remote users hit the
  VPS URL, at the same time.

## Design decisions

- **Tunneling is opt-in and lives in a plugin.** `tapflow relay start` without a flag behaves
  exactly as before. The relay, the WebSocket protocol, and the dashboard have no tunnel code;
  a `TunnelPlugin` (`start(relayPort) → { publicUrl }`, `stop()`) spawns the tunnel process, so
  new providers (rathole, cloudflared, and so on) drop in without touching the relay.
- **Config mirrors the other secrets.** Tunnel settings live in `tapflow.config.json`, the
  token in an environment variable, consistent with the JWT/SMTP pattern. The CLI flag is an
  override for config-less one-off runs.
- **No list of free public tunnel servers is shipped**, which would conflict with the privacy
  principle.
- **Rejected**: Tailscale/Headscale (requires the viewer to install a client) and a
  cloud-hosted relay (fails the RTT constraint above).
