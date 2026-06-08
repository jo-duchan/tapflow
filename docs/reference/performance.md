# Performance & Latency

This page is a record of how tapflow streaming **actually measures**. Every number comes with its measurement conditions, and you can run the same measurements yourself via [Reproduce it](#reproduce-it) at the end. These aren't marketing figures — they're what came out, under what conditions.

::: tip In one line
Bandwidth is not a bottleneck (it uses a single-digit percentage of a home Wi-Fi link), and decode latency on a real LAN is single-digit to a few tens of milliseconds. Glass-to-glass — finger to screen — adds a network round trip on top, and that sum is **estimated** to fit within the ~100 ms budget known as the limit where people feel they are "directly manipulating" objects<sup><a href="#ref-nielsen">1</a></sup>.
:::

## What we measured, and how

tapflow negotiates the codec per client. The path most teams actually use is **LAN (HTTP)**, which is not a secure context, so the browser uses the **WASM (tinyh264) software decoder**. The baseline numbers on this page are therefore that WASM path. On HTTPS (a secure context), hardware-accelerated **WebCodecs** is used and is faster, but it needs a certificate setup, so it is an optional path for now.

We track two distinct metrics.

| Metric | Definition | Valid where |
|--------|------------|-------------|
| **decode→present** | from the viewer receiving a frame, to decoding and drawing it on screen | valid everywhere (a delta within one machine) |
| **glass-to-glass** | from the moment the screen is captured, to it being shown in the viewer | **valid only on a single clock (localhost)** |

`glass-to-glass` is a subtraction between the capture time (agent machine) and the present time (viewer machine), so it cannot be measured directly on a LAN where the two machines run different clocks. On a LAN we therefore measure `decode→present` (valid in any environment) and treat the full perceived latency as an [estimate](#end-to-end-estimate).

## Bandwidth

The H.264 stream barely uses any bandwidth. A still screen is negligible, and it only spikes briefly in the worst case where the whole screen changes, such as scrolling.

| Scenario | Per frame | Bandwidth | vs JPEG |
|----------|-----------|-----------|---------|
| Still | ~1.8 KB | ~14 KB/s | ~140× less |
| Scroll | ~90–110 KB | ~2.6 MB/s | ~5× less |

The scroll peak of ~2.6 MB/s is about 21 Mbps. Given that IEEE 802.11ac (Wi-Fi 5) specifies a single-link throughput of **≥500 Mbps**<sup><a href="#ref-80211ac">2</a></sup> and gigabit Ethernet is 1 Gbps, this uses only a single-digit percentage of one home Wi-Fi link. **Bandwidth is not a bottleneck.**

## Decode latency

A real-LAN measurement. The agent (build machine) and the viewer sit on **two different Macs** connected over the same LAN, and this is the mean of four repeated runs of the viewer-side WASM (tinyh264) decoder's `decode→present`.

| Scenario | p50 | p95 |
|----------|-----|-----|
| Still | 11.3 ms | 43.9 ms |
| Scroll | 16.6 ms | 49.9 ms |

For reference, on **localhost (single clock)** — with the network factored out — the full `glass-to-glass` can be measured, and there the WASM path was 9.6 ms still / 16 ms scroll, on par with localhost JPEG (the closest baseline to direct manipulation). In other words, decode itself floors at single-digit to low-double-digit milliseconds as the network approaches zero.

## End-to-end estimate

::: warning This is an estimate (not a measurement)
The following is a **component sum** — the measured `decode→present` plus published network-latency specs. The LAN `glass-to-glass` cannot be measured directly because of the two-clock problem described above, so we do not assert it.
:::

The full finger-to-screen latency is composed roughly of:

- **Decode** (measured on LAN): p50 11–17 ms, p95 ~44–50 ms
- **Network round trip**: wired LAN <1 ms; Wi-Fi 6 is in the single-digit ms range — OFDMA is reported to bring the median below 5 ms in non-saturation conditions<sup><a href="#ref-80211ax">3</a></sup>
- **Capture & encode** (agent side, measured on localhost): agent→relay ~1 ms, plus the capture cadence (iOS 30fps polling is 0–33 ms)

Comparing that sum against the **~100 ms limit where people feel they are "directly manipulating" objects**<sup><a href="#ref-nielsen">1</a></sup>, the share tapflow controls — decode and transport — takes up only part of that budget. Quality studies on the same class of remote interactive streaming (cloud gaming) likewise place the comfort limit around ~100 ms<sup><a href="#ref-cloudgaming">4</a></sup>.

The exact value varies by environment. The most honest approach is to **run `ping` on your operating LAN** and plug it into the network term above.

## Known limitations

- LAN `glass-to-glass` cannot be measured directly because the agent and viewer run different clocks. The perceived numbers above are estimates.
- Scroll **p95 climbs to ~50 ms**. In moments of heavy motion, more so than on a still screen, the budget can get tight. Measurements show this tail comes from load and transport, not the decoder.
- There is no real-LAN measurement of the HTTPS (WebCodecs) path yet — only a localhost proxy (3.9 ms still / 3.4 ms scroll `glass-to-glass`).
- About 5% of older browsers (no WebGL2) fall back to JPEG. Bandwidth rises, but it works.
- Resolution downscaling reduces bandwidth and decode load at the cost of some fidelity (optional; native by default).
- Android emulators are bound by a software H.264 encoder, which limits frame production. A host-encode path mitigates this, and real devices use a hardware encoder.

## Reproduce it

Performance instrumentation is on only in the dev build (Vite `:3001`); you force a decoder via a URL query and read p50/p95 from the `?perf=1` panel.

```sh
pnpm --filter @tapflowio/dashboard dev
```

In the browser, append `?perf=1` and `?decoder=` (`wasm` / `webcodecs` / `mse` / `jpeg`) to compare tiers. For a cross-machine LAN measurement, open the viewer on another Mac on the same LAN.

The full pipeline analysis, decoder selection process, and the accumulated measurement log and decision record remain in the engineering log as-is — [streaming-latency-log.md](https://github.com/jo-duchan/tapflow/blob/main/contributing/streaming-latency-log.md).

## References

1. <a name="ref-nielsen"></a> Jakob Nielsen, "Response Time Limits" (Nielsen Norman Group). 0.1 s (100 ms) is the limit at which users feel they are directly manipulating UI objects, creating the illusion of an instantaneous response. <https://www.nngroup.com/articles/response-times-3-important-limits/>
2. <a name="ref-80211ac"></a> IEEE 802.11ac-2013. Single-link ≥500 Mbps, multi-station ≥1.1 Gbps. <https://en.wikipedia.org/wiki/IEEE_802.11ac-2013>
3. <a name="ref-80211ax"></a> "Experimental Evaluation of IEEE 802.11ax — Low Latency and High Reliability with Wi-Fi 6?" (IEEE) and "A First Look at Wi-Fi 6 in Action" (ACM). OFDMA lowers the median latency from ~5 ms to under 1 ms in non-saturation conditions. <https://ieeexplore.ieee.org/document/10001475/>
4. <a name="ref-cloudgaming"></a> Quality-of-experience research on cloud gaming finds that player QoE begins to degrade beyond a 100 ms latency threshold (Jarschel et al., 2011), as cited in G. Illahi et al., "Cloud Gaming With Foveated Graphics" (arXiv:1809.05823) §4.3.2. <https://arxiv.org/abs/1809.05823>
