# Measuring tapflow performance — Reference

> The single reference for tapflow's instrumentation surface — every metric emitter, how to turn it on, its exact output, and what it means. The chronological decisions behind the streaming pipeline live in [`streaming-latency-log.md`](./streaming-latency-log.md); the user-settable tuning knobs (codec, bitrate, resolution, fps) are documented for operators in [`docs/reference/configuration.md`](../docs/reference/configuration.md#streaming-tuning-agent). This file is the contributor-facing "where do I read the numbers" index.

---

## Agent-side metrics — `TAPFLOW_STREAM_METRICS=1`

One opt-in flag turns on several stderr emitters at once. Run any agent with it set:

```bash
TAPFLOW_STREAM_METRICS=1 pnpm dev                          # default codec
TAPFLOW_STREAM_METRICS=1 TAPFLOW_IOS_CODEC=h264 pnpm dev   # H.264
```

| Emitter | Output line | Cadence | Platform | Meaning |
|---|---|---|---|---|
| **throughput** | `stream metrics [<deviceId>] NNfps NNKB/s avg=NNKB drop=N.N% (dropped/produced)` | every 5 s | iOS + Android | Encoder output (the cause): send fps, bandwidth, average frame size, drop rate. From `createThroughputSampler` (`agent-core/src/utils/throughput.ts`). |
| **tear-guard** | `info: tear-guard retries=N exhausted=N frames=N` | every 150 frames | iOS, H.264 | Tear-free snapshot retries (`copySurfaceStable`). `retries` climb during scroll (a write raced the read), flat when static; `exhausted` should stay **0** — a nonzero value means the 4-retry budget ran out and a torn frame may have shipped. See ios-agent AGENTS.md → "Tear-free framebuffer snapshot". |
| **capture-wait** | `info: capture-wait avg=N.Nms max=N.Nms n=N` | every 150 changed frames | iOS | Polling gap between an IOSurface change and when the timer encodes it (`surfaceChange → encodeStart`). Keep-alive / forced-keyframe re-sends are excluded. Bounded by the frame interval (~33 ms at 30 fps); avg is small under continuous motion. Added for [#195](https://github.com/jo-duchan/tapflow/issues/195). |

**Relay drops (not gated by the flag — always logged):**

| Emitter | Output line | Source | Meaning |
|---|---|---|---|
| **ws backpressure** | `ws backpressure: N frame(s) dropped [<context>]` | `agent-core/src/utils/stream.ts` | Frames dropped on the relay→browser hop when the socket buffer exceeds `TAPFLOW_WS_BACKPRESSURE_BYTES` (default 1 MB). The *effect* whose *cause* is the throughput line above. Rate-limited to one warning/sec per session. |

---

## Browser-side — `?perf=1`

Open the dashboard with `?perf=1` (or toggle `Ctrl+Shift+P`). **DEV-build only** (`import.meta.env.DEV`): it is on in the Vite dev server (`:3001`), **not** in the built LAN relay (`:4000`).

**Per-stage latency panel** (`tweakpane`, `MetricsPanel.tsx` / `FrameLatencyTracker.ts`): a `p50/p95 ms` folder showing **glass→glass · decode→present · agent→relay** live, plus recv-fps / decodeMs / paintMs graphs.

- `Log latency summary` button → prints the accumulated trace as JSON to the console.
- `Export trace` → a `chrome://tracing`-compatible trace.
- **glass→glass is `present − capturedAt` (epoch), so it is valid only on a single clock** — i.e. localhost, or the agent and the viewer on the same machine. Across two machines, compare **decode→present** (a same-machine delta) instead.

**Console tags** (DEV):

| Tag | Example | Source | Meaning |
|---|---|---|---|
| `[decoder]` | `[decoder] using WebCodecs` | `useDecoderStream.ts` | Which decoder tier was selected (WebCodecs / WASM / MSE / JPEG). |
| `[wc-diag]` | `[wc-diag] decodeMs=8.7 queueSize=0` | `useDecoderStream.ts` | WebCodecs decode time + queue depth, sampled every 30 frames. |
| `[sps-vui]` | `[sps-vui] {"maxNumReorderFrames":0,...}` | `WebCodecsCore.ts` | Parsed H.264 SPS VUI — confirms the agent's `reorder=0` rewrite reached the browser. |
| `[latency]` | `[latency] {"decodeMs":{"p50":8,"p95":18},...}` | `MetricsPanel.tsx` | The JSON summary printed by `Log latency summary`. |

**Force a decoder tier** (DEV override) — compare tiers on one clock without a non-secure LAN context:

```text
http://localhost:3001?perf=1                 # auto-select (localhost = WebCodecs)
http://localhost:3001?perf=1&decoder=mse     # force MSE (the LAN tier)
http://localhost:3001?perf=1&decoder=wasm    # force tinyh264 (plain-HTTP LAN tier)
```

MSE **buffers** rather than dropping, so the submit↔present FIFO tracker is accurate 1:1 even without WebCodecs's timestamp matching. iOS only — AndroidViewer has no `?decoder=` override.

---

## Host resource sampling — `agent:resources`

`createResourceSampler` (`agent-core/src/utils/resources.ts`) samples host CPU and memory every 5 s and the agent sends an `agent:resources` WebSocket message (not a log line). It feeds the dashboard's agent cards and the relay's boot-time resource gate (a session is refused when CPU/RAM exceed `TAPFLOW_RESOURCE_THRESHOLD_PERCENT`, default 80). It is **always on** — no flag.

---

## How to measure (procedures)

### localhost single clock (the valid glass→glass environment)

```bash
TAPFLOW_STREAM_METRICS=1 TAPFLOW_IOS_CODEC=h264 pnpm dev   # :3001?perf=1 → H.264 per-stage
TAPFLOW_STREAM_METRICS=1                       pnpm dev    # :3001?perf=1 → JPEG baseline
```

Vite `:3001` is the DEV build, so the panel and overrides are on. glass→glass is valid here (single clock).

> The built LAN relay (`:4000`) serves `packages/relay/public/`. Dashboard source changes need `pnpm --filter @tapflowio/dashboard build` then a `:4000` refresh — and even then the perf panel stays off (DEV-only).

### cross-machine LAN (remote viewer)

To measure decode on a real remote machine over a real network hop, the viewer must hit the **Vite dev server (`:3001`)** — the built `:4000` has neither the panel nor the `?decoder=` override. The dashboard's WS target is `VITE_RELAY_URL` (hardcoded to `ws://localhost:4000` in `packages/dashboard/.env.development`), so a remote browser would resolve that to its *own* localhost. Override it with the host's LAN IP:

```bash
# on the host (relay + agent + simulator):
pnpm dev:relay   # + pnpm dev:ios   (or the full `pnpm dev`)
ipconfig getifaddr en0                                   # host LAN IP, e.g. 192.168.0.42
VITE_RELAY_URL=ws://192.168.0.42:4000 \
  pnpm --filter @tapflowio/dashboard dev --host          # --host binds :3001 to the LAN
```

```text
# on the remote viewer, in the browser:
http://192.168.0.42:3001/?perf=1&decoder=wasm
```

The host firewall must allow `:3001` and `:4000` on the LAN. **Clock caveat:** across two machines glass→glass is invalid — compare **decode→present** plus relay backpressure drops and felt smoothness.

---

## Tuning knobs that change what you measure

The agent env that affect fps / bandwidth / resolution / codec — `TAPFLOW_IOS_CODEC`, `TAPFLOW_IOS_H264_BITRATE`, `TAPFLOW_JPEG_QUALITY`, `TAPFLOW_*_MAX_SIZE`, `TAPFLOW_ANDROID_FPS`, `TAPFLOW_ANDROID_BACKEND` — are documented for operators in [`docs/reference/configuration.md` → Streaming tuning](../docs/reference/configuration.md#streaming-tuning-agent). Set them alongside `TAPFLOW_STREAM_METRICS=1` to A/B a knob.

## Related

- [`streaming-latency-log.md`](./streaming-latency-log.md) — the chronological glass-to-glass campaign (pipeline analysis, decisions, accumulated measurements).
- [`android-video-streaming-diagnosis.md`](./android-video-streaming-diagnosis.md) — scrcpy / emulator-encoder investigation.
- [`awdl-wifi-latency-diagnosis.md`](./awdl-wifi-latency-diagnosis.md) — diagnosing periodic Wi-Fi hitching (AWDL), a radio-layer issue the metrics above won't catch.
