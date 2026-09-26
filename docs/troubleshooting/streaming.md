---
title: Stream & sessions
description: A stream that lags or stutters — Wi-Fi (AWDL), host load, display sleep, low resolution on a LAN — and a session that ends by itself.
---

# Stream & sessions

Fixes for a stream that stutters or looks blurry, and for a session that ends by itself.

## Stream lag or stuttering {#stream-lag}

Narrow it to one of three causes — the network between agent and relay, the agent Mac's resources, or display sleep.

### Prefer a wired LAN

The agent streams video frames to the relay continuously, so the link between them sets the baseline smoothness. **Wired Ethernet is recommended** for the relay and agent machines. Wi-Fi works, but it adds latency and jitter — and on the relay Mac it can cause the periodic hitching below.

### Periodic hitching every ~0.5s on Wi-Fi (AWDL)

If the stream stutters in a steady rhythm (roughly twice a second) over Wi-Fi, the likely cause is **AWDL** (Apple Wireless Direct Link), the interface behind AirDrop, AirPlay, Handoff, and Sidecar. It periodically hops Wi-Fi channels, leaving the data channel for ~90 ms each time, which surfaces as a sawtooth latency spike and a visible hitch.

The robust fix is a **wired connection**: over Ethernet the data never rides Wi-Fi, so AWDL is irrelevant.

If you must stay on Wi-Fi, quiet AWDL from System Settings (reversible, no admin needed):

- **AirDrop** → "No One"
- **AirPlay Receiver** → off (System Settings → General → AirDrop & Handoff)
- **Handoff** → off (same pane)
- **Bluetooth** → off

AWDL only hops when something triggers it (AirDrop browsing, AirPlay, Handoff, Bluetooth proximity); with those quiet it stays idle.

To confirm, ping the router at a tight interval from the relay Mac and watch for the sawtooth: run `ping -i 0.01 <router-ip>`, and if the sawtooth disappears on a wired connection, AWDL was the cause.

::: tip Advanced: disabling awdl0 directly
`sudo ifconfig awdl0 down` disables AWDL for the session. It's temporary (reverts on reboot or the next time you use AirDrop) and needs admin, so prefer the toggles above or a wired link.
:::

### Host CPU / RAM pressure

The simulator and the H.264 encoder are the heavy consumers; when the agent Mac is starved (especially under memory pressure), capture and encode fall behind.

- Check CPU and RAM for the affected Mac in the **Mac Resources** tab.
- Run the relay and the agent on **separate Macs** so they don't compete for resources (this also scales agent capacity).
- Reduce the number of simulators running at once on one Mac.

### Display sleep

By default the agent keeps the host display awake while a session is active, because a sleeping display parks the GPU and throttles the simulator. If you set `TAPFLOW_ALLOW_DISPLAY_SLEEP=1`, expect the stream to slow whenever the display turns off. See [Agent Setup](/operate/agents#host-display-and-sleep).

### Blurry or low-resolution stream on LAN

A plain-HTTP LAN connection uses the **Standard** profile, which caps the stream at 1280 px (longest side) so the WASM decoder stays responsive. To stream at the simulator's native resolution, serve the relay over HTTPS — that moves you to the **Smooth** profile (hardware decoding, native resolution). See the [certificate method in Configuring tapflow](/operate/configure#_3-certificate-method-when-smooth-is-chosen). You can also raise the cap without HTTPS by setting `TAPFLOW_MAX_SIZE_LAN` on the agent; see [Streaming Quality](/operate/streaming-quality).

## Session issues

### Session ends automatically

5 minutes after the browser disconnects, the relay asks the agent to shut the device down. While a browser stays connected, nothing times out, even with no input. Change the delay with the relay's `IDLE_TIMEOUT_MS` environment variable (in milliseconds). Reconnect from the dashboard.
