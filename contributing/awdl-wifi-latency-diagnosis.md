# Wi-Fi Relay Latency Diagnosis (AWDL) — Insights

> This document records how a periodic stream hitch on a Wi-Fi relay was traced to **AWDL** (Apple Wireless Direct Link), led by ICMP ping (with `wdutil` and `ifconfig` to corroborate and confirm) — no guessing. The user-facing remedy lives in [`docs/guide/troubleshooting.md`](../docs/guide/troubleshooting.md) ("Stream lag or stuttering"); this is the engineering backing — the method, the evidence, and the dead ends — kept out of the user docs deliberately.

---

## Conclusion

On a Wi-Fi relay (notably a **laptop** Mac), AWDL — the interface behind AirDrop, AirPlay, Handoff, and Sidecar — periodically hops Wi-Fi channels, leaving the data channel for ~90 ms roughly twice a second. This shows up as a **sawtooth RTT spike** and, in the video stream, a visible hitch every ~0.5 s.

- **Root fix**: wired Ethernet (the data never rides Wi-Fi, so AWDL is irrelevant).
- **Wi-Fi-only mitigation**: quieting AWDL triggers from System Settings (AirDrop → "No One", AirPlay Receiver off, Handoff off, Bluetooth off) removes the sawtooth without `root`, a router change, or a daemon — fully reversible.
- **tapflow stance**: diagnose and guide only. We do **not** touch `awdl0` from the product (needs root, overreach, breaks AirDrop). Recommend wired; warn on a detected Wi-Fi relay.

This is **not** a code regression and **not** a WebSocket/encode/decode problem — the whole pipeline measured tier-1 optimal. AWDL is a radio-layer issue around the pipeline.

---

## Symptom

In the "agent and relay on **different** Macs over Wi-Fi" configuration:

- `ping` to the router showed a ~0.5 s period sawtooth — RTT climbing to ~90 ms then stepping back down — repeating steadily.
- In the live stream this surfaced as a hitch about twice a second, regardless of signal strength.

The same content over the loopback / wired path was smooth, which is what made it look like a "different Mac is slower" problem at first (it was not — see [Same Mac vs separated](#same-mac-vs-separated-correcting-a-misread)).

---

## Diagnosis (ping-led, no guessing)

The whole point of this log: the fault was **localized with `ping`** by ruling things out rather than speculating, then corroborated with `wdutil` and confirmed with `ifconfig awdl0`. Every hypothesis had a measurement attached.

### Step 1 — the sawtooth persists under active load

```bash
ping -i 0.01 <router-ip>   # 100 Hz, both idle and while actively streaming
```

The sawtooth appeared **even while a standalone ICMP process was actively sending** — i.e. it hit a process that has nothing to do with the stream. That single observation rules out a whole class of suspects at once:

- idle Wi-Fi power save (PSM) — excluded (happens under active send)
- macOS App Nap — excluded (ICMP isn't napping)
- WebSocket / our transport — excluded (ping doesn't use it)
- bufferbloat / queue buildup — excluded (idle ping sawtooths too)
- airtime contention — excluded (a lone sender on a quiet link still sawtooths)

So it is **not** anything in tapflow's data path. It is something periodically stealing the radio.

### Step 2 — the link itself is healthy

```bash
sudo wdutil info
```

RSSI −46, noise −95, 5 GHz / 80 MHz / 11ax, CCA (channel busy) 13%. The RF link is excellent and uncongested → **RF quality and congestion are innocent**. The periodic loss is not the air being bad; something on the host is leaving the channel.

### Step 3 — triangulation (AP vs peer, machine vs machine)

Compare the same `ping -i 0.01 <router>` from each machine:

| Source → target | avg / max / stddev (ms) | verdict |
|---|---|---|
| Mac mini → AP | ~ / ~ / **0.65** | clean |
| MacBook Air (relay) → AP | 13.1 / 99.7 / **21.2** | sawtooth |

The jitter (stddev) localizes the fault to the **relay laptop**, not the network. The Mac mini on the identical AP is clean; only the laptop sawtooths.

---

## Root cause — AWDL

```bash
ifconfig awdl0          # MacBook Air: "status: active"  |  Mac mini: absent / down
```

The laptop had `awdl0` **active**; the Mac mini did not. AWDL periodically hops Wi-Fi channels to service AirDrop/AirPlay/Handoff discovery, and each hop leaves the data channel for ~90 ms — exactly the sawtooth period and amplitude.

Confirmation by removing it:

```bash
sudo ifconfig awdl0 down
```

| relay → AP | avg / max / stddev (ms) |
|---|---|
| before | 13.1 / 99.7 / 21.2 |
| after `awdl0 down` | 4.4 / 13.9 / **0.81** |

The sawtooth vanished. Cause confirmed.

---

## Fix tiers (measured 2026-06-19)

Ordered by preference for an OSS, non-invasive product.

1. **Wired Ethernet** — fundamental, non-destructive, permanent. With a wired link the data never rides Wi-Fi, so AWDL can stay up and is irrelevant. This is the recommendation.

2. **Quiet AWDL triggers from System Settings** (first choice when Wi-Fi is mandatory):
   - AirDrop → **"No One"**
   - AirPlay Receiver → **off** (System Settings → General → AirDrop & Handoff)
   - Handoff → **off**
   - Bluetooth → **off**

   Measured: **without** `awdl0 down`, stddev went 21 → **0.95** — sawtooth gone, on par with `awdl0 down` (0.81). No root, no router change, no daemon, fully reversible. **Key insight: AWDL does not hop unless something triggers it** (AirDrop browsing, AirPlay receiving, Handoff, Bluetooth proximity); with the triggers quiet, `awdl0` can stay `up` and idle.

   Limits (state them honestly): which single toggle is decisive was not isolated (AirDrop "No One" + AirPlay Receiver off are the likely pair); Bonjour can occasionally re-activate AWDL over long sessions (not observed in a 20 s window); behavior is macOS-version-dependent — so **pair any of this with a `ping` re-check**.

3. **`sudo ifconfig awdl0 down`** (session-only, advanced) — only if the toggles are insufficient. Temporary (reverts on the next AirDrop use or reboot) and needs `root`.

---

## Excluded approaches (and why)

- **Pinning the Wi-Fi channel (e.g. 149)** — router-dependent, doesn't generalize for self-hosters.
- **A launchd daemon to hold `awdl0` down** — invasive, needs root, fights the OS.
- **Third-party tools** (`ping-warden`, etc.) — cat-and-mouse with macOS, unsuitable as an OSS default.
- **A macOS API to disable AWDL** — none exists (confirmed via Apple DTS). The newer Wi-Fi Aware real-time API is iOS/iPadOS 26+ only, not macOS ([Apple TN3111 — iOS Wi-Fi API overview](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview), [Wi-Fi Aware framework](https://developer.apple.com/documentation/WiFiAware)).

This is why tapflow's product behavior is limited to **detect + guide**, never manipulating `awdl0`.

---

## Reusable method

For any "smooth on wired / hitchy on Wi-Fi" report:

1. `ping -i 0.01 <router>` on the suspect machine, **idle and under load**. A steady sawtooth that survives active load means the radio is being periodically stolen — not your data path.
2. `sudo wdutil info` to clear RF/congestion (RSSI, noise, CCA).
3. **Triangulate**: ping the AP from each machine and compare **stddev**. The high-jitter machine is the culprit.
4. `ifconfig awdl0` to check AWDL; `sudo ifconfig awdl0 down` to confirm by removal.

The lesson worth carrying: **WebSocket micro-optimizations are irrelevant to this kind of perceived latency.** On a Wi-Fi relay laptop, AWDL is a common hidden cause.

---

## Related context

### Same Mac vs separated (correcting a misread)

Running the agent **and** relay on one Mac is normally *slightly faster*, not slower: `agent → relay` is loopback (off the network), so only one Wi-Fi/AWDL hop remains (relay → browser), versus two when separated (`agent → relay` + `relay → browser`). The "same Mac feels slower" impression during this investigation was a misread. Separation's benefit is **resource-contention relief + horizontal agent scaling**, not latency.

### Resource pressure — the other Wi-Fi-independent variable

The Smooth (HTTPS/WebCodecs) path itself showed **no code regression**: decode (`optimizeForLatency`, SPS reorder = 0), render (direct GPU, no rAF / media buffer), and relay (no-delay both HTTP/HTTPS, compression off) are all tier-1 optimal. The remaining perceived-latency variation comes from **host resource pressure (RAM/swap, simulator source render) + AWDL**, not the codec path. The hardware encoder (VideoToolbox) is largely insensitive to CPU contention; what gets squeezed under pressure is everything *around* it (source render, pre-encode work, RAM). Remedy: wired + separated + RAM headroom. Single-Mac adaptive encoding under pressure is deferred to **[#310](https://github.com/jo-duchan/tapflow/issues/310)**.

---

## References

- User-facing remedy: [`docs/guide/troubleshooting.md`](../docs/guide/troubleshooting.md) → "Stream lag or stuttering"
- Resource-aware adaptive encoding (deferred): [#310](https://github.com/jo-duchan/tapflow/issues/310)
