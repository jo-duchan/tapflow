---
type: reference
topics: [streaming, performance, downscale, lan]
status: stable
related: [streaming-latency-log, measurement]
---

# Downscale tuning (tier1 LAN-HTTP)

How to set the encode-resolution downscale, and the measurements behind the recommended default.
The lever trades **design-QA fidelity** for **viewer decode load + bandwidth** — the two costs that
dominate tier1 on LAN-HTTP (non-secure context → WASM `tinyh264` decode in the browser).

## The knobs

- `TAPFLOW_MAX_SIZE` — cross-platform cap on the **longest side** (px). `0`/unset = native.
- `TAPFLOW_IOS_MAX_SIZE` / `TAPFLOW_ANDROID_MAX_SIZE` — per-platform override (takes precedence).

iOS scales the VT-encoder input with `vImageScale_ARGB8888` (high-quality resampling). Android uses
the emulator's gRPC server-side resize (free — it resizes before sending). Both preserve aspect and
round to even dimensions (H.264 requirement).

## What each column means

- **pixel %** — resolution vs native. The proxy for **decode CPU load** (WASM decode ≈ ∝ pixels).
  This is the tier1 LAN-HTTP bottleneck; measure the real ms as **decode→present** (see below).
- **scroll KB/s** — **bandwidth**, governed by the H.264 bitrate (8 Mbps soft cap) + motion, *not*
  pixel count directly.
- **static KB/frame** — per-frame bytes on a still screen (more resolution-proportional than scroll).

## Measurements (2026-06-07, Settings app, 30fps cap)

Methodology: same screen (Settings) + same scroll across all sizes; agent-side byte measurement
(Android via `EmulatorVideo`, iOS via `screencapture-helper` + `touch-helper`). decode→present is
viewer-side (WASM) — left blank here, fill it from the perf overlay (recipe below).

### Android (emulator `Pixel_9_API_36`, native 1080×2424)

| maxSize | dims | pixel % | static KB/f | scroll KB/s | decode→present (ms) |
|---|---|---|---|---|---|
| native | 1080×2424 | 100% | 46 | **165** | _ |
| 1600 | 712×1600 | 44% | 34 | 77 | _ |
| **1280** | 570×1280 | **28%** | 27 | **76** | _ |
| 1000 | 445×1000 | 17% | 27 | 92\* | _ |
| 800 | 356×800 | 11% | 21 | 82\* | _ |
| 600 | 267×600 | 6% | 18 | 69 | _ |

### iOS (simulator `iPhone 15 Pro`, native 1178×2556)

| maxSize | dims | pixel % | static KB/f | scroll KB/s | decode→present (ms) |
|---|---|---|---|---|---|
| native | 1178×2556 | 100% | 48 | **57** | _ |
| 1600 | 738×1600 | 39% | 30 | 35 | _ |
| **1280** | 590×1280 | **25%** | 26 | **34** | _ |
| 1000 | 460×1000 | 15% | 23 | 32 | _ |
| 800 | 368×800 | 10% | 20 | 34 | _ |
| 600 | 276×600 | 5% | 17 | 28 | _ |

\* scroll KB/s carries motion-dependent noise (the scroll isn't pixel-identical across runs); read
the *trend*, not single cells.

> **Absolute KB/s is not comparable across platforms here** — iOS used alternating up/down swipes
> (+ iOS H.264 static-skip drops unchanged frames), Android used a one-directional continuous fling.
> The **per-platform pattern** is the takeaway, not iOS-vs-Android absolute numbers.

## Findings

1. **Bandwidth has a floor.** native → any downscale drops it sharply (Android 165→~76, iOS 57→~34),
   then **barely improves below ~1280** — at low resolution the bitrate is motion/encoding-bound, not
   pixel-bound. So for **bandwidth alone, 1280 already captures nearly the whole win.**
2. **Decode load (pixels) keeps falling linearly.** Going below 1280 only buys **less viewer decode
   CPU at a fidelity cost** — no further bandwidth benefit. That trade is what decode→present measures.
3. **Visual** (PNG samples): **1280 keeps text crisp** on both platforms; **600 softens fine print**
   (especially gray subtitles / dense Korean glyphs) — borderline for design QA.

## Recommendation

**`TAPFLOW_MAX_SIZE=1280`** (longest side) as the LAN-HTTP starting point: ~most of the bandwidth
savings, crisp text, decode load at ~25–28% of native. Go lower (1000/800/600) **only** when a
low-end viewer's decode→present is still too high — accepting the fidelity loss. Keep native for
localhost / LAN-HTTPS (WebCodecs hw decode handles full res cheaply).

## How to fill decode→present (viewer-side, WASM)

decode→present is **browser-side and only meaningful on LAN-HTTP (WASM)** — on localhost it's
WebCodecs (hardware), so the downscale effect on decode is invisible. The perf overlay is **DEV-only**.
To get **WASM + overlay together**, serve the Vite dev build on the LAN and open it via the LAN IP
(a non-secure origin → WASM), not `localhost`:

1. Run the dev stack with a chosen size, Vite bound to the LAN:
   `TAPFLOW_MAX_SIZE=1280 pnpm dev` (dashboard dev must listen on `--host`).
2. Open `http://<LAN-IP>:3001/?perf=1` (e.g. `http://192.168.219.197:3001/?perf=1`) — **not** localhost.
3. Boot the device, scroll, and read **decode→present p50/p95** from the overlay (`Ctrl+Shift+P`).
4. Restart `pnpm dev` with the next `TAPFLOW_MAX_SIZE` and repeat.

## Inspecting fidelity visually

- Live: `TAPFLOW_MAX_SIZE=<N> pnpm dev`, view, restart per N (most faithful — real upscale + motion).
- Static samples generated during measurement: `/tmp/ds-{and,ios}-{native,1600,1280,1000,800,600}.png`
  (compare at the same display size; the browser upscales these to the viewport).
