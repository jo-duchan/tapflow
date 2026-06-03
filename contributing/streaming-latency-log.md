# Streaming latency engineering log — tier1 goal: feels-like-direct responsiveness

A running, append-only engineering log for tapflow's glass-to-glass latency work on tier1
(localhost + LAN). It records pipeline analysis, measurements, attempts, and decisions in
chronological order — useful context for anyone touching the streaming render path. Unlike
`.work/` (local, throwaway) it is committed and kept.

> **Goal:** on tier1 (localhost + LAN), reach **localhost-JPEG-class responsiveness** (glass-to-glass
> latency where operating the simulator/emulator in the browser feels nearly as direct as touching
> it locally). This is the start of tapflow's core value: no-install, low-friction, low-latency
> remote control.
>
> **Where it stands:** MSE was dropped for a 2-tier decoder path — WebCodecs on secure contexts
> (HTTPS/localhost), WASM (tinyh264) on plain HTTP — reaching localhost-JPEG-class latency with no
> media-element buffer. relay drop-to-keyframe removes tearing under LAN backpressure, and H.264 is
> now the negotiated default. Same pipeline on iOS and Android.
>
> **Measurement tools:** `TAPFLOW_STREAM_METRICS=1` (agent throughput) · relay `ws backpressure`
> (drops) · the per-stage `?perf=1` panel (capture→display). Environment: LAN + HTTP / localhost,
> iPhone 16 Pro, macOS.

---

## 1. The problem — two demands at once

Feels-like-direct responsiveness needs **both**:
1. **Low latency** (responsiveness) — the screen follows the instant you swipe.
2. **No drops** (smoothness) — no tearing from backpressure drops.

So far no path has delivered both at once:

| Path | Latency | Drops (bandwidth) |
|------|------|--------------|
| **JPEG** | ✅ low (frame-independent, instant decode) | ❌ large → LAN scroll relay drops 16–27/s (tearing) |
| **H.264** | ❌ high (encoder + HW-decoder pipeline; on LAN, + MSE buffer) | ✅ small → drops 1–11/s |

→ **Only localhost-JPEG meets the bar.** LAN-JPEG tears; H.264 (local/LAN) misses the bar on latency.

---

## 2. Pipeline & bottleneck (glass-to-glass)

| Stage | JPEG | H.264 (ours) | Cloud gaming |
|------|------|--------------|------------------|
| Touch send (browser→relay→agent→HID) | same | same | same |
| Simulator scroll render | same (simulator-inherent) | same | — |
| Capture (30fps polling) | 0–33ms | 0–33ms | — |
| Encoder pipe | 0 (instant) | VT (minimized with MaxFrameDelayCount=0) | NVENC low-latency preset |
| **Transport + buffer** | instant | **LAN = MSE media buffer ← the core bottleneck** | UDP/WebRTC mini jitter buffer |
| Decoder | createImageBitmap, instant | WebCodecs (low-latency) / **MSE (buffered)** | HW low-latency decode |

**Key insights:**
- The bottleneck is not "H.264 vs JPEG" but the **decode/transport path**. **Cloud gaming hitting glass-to-glass <50ms with H.264 is the existence proof** — H.264 can deliver low bandwidth and low latency together.
- **The real problem is using MSE on LAN-HTTP.** MSE is buffering by nature, so it is structural latency. Cloud gaming does not use MSE.
- **Why we were stuck with MSE = the secure-context wall:** WebCodecs (zero-buffer, HW) only works on HTTPS/localhost → LAN-HTTP is non-secure, so it gets demoted to MSE.

---

## 3. Decoder tier model (decided — 2-tier, MSE removed)

`pickDecoder` selects automatically per environment. **MSE is fully removed** and simplified to 2 tiers — WebCodecs if secure, else WASM. **Same pipeline** on iOS and Android:

| Environment | Decoder | Characteristics |
|------|--------|------|
| HTTPS / localhost (secure) | WebCodecs | HW, lowest latency, all profiles |
| **HTTP (non-secure)** | **WASM (tinyh264)** ✅ measured PASS | CPU, low-latency, zero-buffer, baseline only |
| WebGL2/WASM unavailable | null (notice) | — |

> **Why MSE was removed (2026-06-02):** MSE has a structural ~235ms from the `<video>` buffer — goal unreachable. WebCodecs (secure) + WASM (HTTP) cover every environment, so an MSE fallback is needless complexity. The jmuxer dependency is dropped too.
> **Android baseline premise:** WASM (tinyh264) only decodes (constrained-)baseline → **pin scrcpy to baseline (`profile:int=1`)** so Android shares the HTTP→WASM path. (High profile only on the WebCodecs=secure path; on plain HTTP, baseline is guaranteed.) iOS uses VideoToolbox baseline.

Why WASM is attractive: **no secure context needed + no media buffer** = JPEG's immediacy + H.264's low bandwidth, both on LAN-HTTP. The cost is **software (CPU) decode** — at high resolution×fps it hits a CPU ceiling. Mitigation: **downscale the encode resolution** (display is small → a triple win on bandwidth, CPU, latency). Precedent: ws-scrcpy decodes phone-resolution baseline H.264 with tinyh264.

---

## 4. Measurement log (accumulated)

### JPEG baseline (LAN, throughput sampler)

| Scenario | Quality | avg/frame | Bandwidth | relay drops/s |
|----------|------|-----------|--------|---------------|
| Still | 0.95 | 427 KB | ~3.3 MB/s | 0 (localhost illusion) |
| Still | 0.8 | 235 KB | ~1.97 MB/s | 0 |
| Scroll | 0.8 | ~590 KB | 12–16 MB/s | **16–27** |

### H.264 (VideoToolbox, steady 30fps)

| Scenario | avg/frame | Bandwidth | relay drops/s |
|----------|-----------|--------|---------------|
| Still | ~1.8 KB | ~14 KB/s (**~140x↓** vs JPEG) | 0 |
| Scroll | ~90–110 KB | ~2.6 MB/s (**~5x↓**) | **1–11** |

→ H.264 **decisively solves bandwidth/drops**. But **perceived latency is worse than JPEG** (below).

### Latency (perceived, qualitative)

| Path | Feel |
|------|------|
| localhost JPEG | **baseline** — feels like direct manipulation |
| localhost H.264 (WebCodecs) | half-beat lag — misses the bar |
| LAN JPEG | responsive but scroll tears |
| LAN H.264 (MSE) | near-zero drops but the largest latency |

> ⚠️ **Precise per-stage latency (ms) not yet measured.** In step 0, measure capture→display + encoder time to rank bottlenecks by number. (Especially *why even localhost-WebCodecs-H.264 misses JPEG* — encoder, decoder, or display path.)

### per-stage latency (step-0 instrumentation — measured 2026-06-02, localhost)

Read from the `?perf=1` panel's `p50/p95 ms` folder + the `[wc-diag]` console (exact timestamp matching).

| Path | decode→present p50/p95 | glass→glass p50/p95 | agent→relay | Note |
|------|----------------------:|--------------------:|------------:|------|
| JPEG still | 12.4 / 15.4 | (≈13)* | 1 | baseline |
| JPEG scroll | 9.4 / 11.6 | (≈11)* | 1 | |
| **H.264 still (before fix)** | **267 / 274** | **235 / 239** | 0–1 | decoder buffers ~8 frames |
| **H.264 WebCodecs still (after fix)** | **2.5 / 4** | **3.9 / 7.9** | 0–1 | reorder=0 injected |
| **H.264 WebCodecs scroll (after fix)** | **2.1 / 3.9** | **3.4 / 7.9** | 0–1 | |
| **H.264 MSE still** | **239 / 254** | **240 / 255** | 0–1 | `<video>` buffer remains even with reorder=0 |
| **H.264 MSE scroll** | **229 / 244** | **230 / 245** | 0–1 | structural even with jmuxer `flushingTime:0` |
| **H.264 WASM still** | **8.7 / 30.4** | **9.6 / 31.5** | 0–1 | tinyh264, no media buffer — JPEG-class |
| **H.264 WASM scroll** | **14.3 / 37.9** | **16 / 40.3** | 1–2 | localhost-JPEG-class responsiveness |

→ **WebCodecs: the fix took decode→present 267→2.5ms (~100x↓), reaching the goal (localhost-JPEG-class).** But **MSE stays ~235ms even on the same reorder=0 stream** — the **media-element (`<video>`) buffer** the SPS fix can't reach (already tuned to `flushingTime:0`, can't shave more). → Measurements confirm **tier1 LAN-HTTP (non-secure, MSE) needs WASM (tinyh264)**. (Measured on localhost single-clock via the `?decoder=mse` dev override — MSE buffers instead of dropping, so the FIFO tracker is accurate.)

→ **Step-2 WASM measurement (2026-06-02, `?decoder=wasm`): gate PASS.** tinyh264 fully avoids MSE's `<video>` buffer → decode→present **still 8.7ms / scroll 14.3ms** (**~27x·~16x↓** vs MSE 239/229), glass→glass 9.6/16ms. **On par with localhost-JPEG (goal 12.4/9.4)** — still is faster than JPEG. Color and feel are good, with CPU headroom (localhost = encoder + decoder on one Mac = worst case, so real LAN has more headroom). → **Goal reached on the non-secure path; downscale (step 3) not needed for now.** Next: flip the pickDecoder tier (non-secure → WASM first).

> \* JPEG glass→glass isn't computed by the panel (`null`) — only on the H.264 tracker path. ≈11–13ms from decode (~10ms) + agent→relay (~1ms).
> **Clock validity:** glass→glass = present(epoch) − capturedAt → **only on a localhost single clock**. decode→present (a delta) and agent→relay (both on the Mac) are valid in every environment.
> **Root cause:** the iOS encoder's SPS does not set `bitstream_restriction` (VUI check: `bitstreamRestriction:false`, Level 5.0). The decoder safely buffers up to the level's max DPB (110400/~13800MB ≈ 8 frames) → 267ms. It's baseline (66) so the actual reorder is 0 — **only the signal is missing**. → Fixed by injecting a `max_num_reorder_frames=0` declaration into the SPS.

---

## 5. Work roadmap (gated by measurement)

Each step **confirms its effect by measurement before the next**. If it fails, roll back/redesign.

| # | Step | Goal | Status |
|---|------|------|------|
| **0** | per-stage latency instrumentation (capture→display, encoder time) | rank bottlenecks by number; analyze localhost-WebCodecs-H.264 | ✅ done — cause = SPS reorder not declared |
| **1** | inject SPS reorder=0 to remove the decoder DPB buffer | bring WebCodecs to localhost-JPEG-class | ✅ done — browser-verified (267→2.5ms) + **moved into the encoder** (ios-agent rewrites the SPS → every decoder benefits; localhost e2e confirms `bitstreamRestriction:true`) |
| 2 | **WASM decoder** + **remove MSE → 2-tier** (HTTPS=WebCodecs/HTTP=WASM, iOS·Android identical) | zero-buffer, no secure context → LAN low latency | ✅ **done** — PR#1 merged, PR#2 smoke PASS (8.7/14.3ms, both platforms LAN-HTTP WASM). Residual tearing → PR-D below |
| 2.5 | **relay drop-to-keyframe (PR-D)** | on LAN drop, discard P up to the next IDR, removing tearing | ✅ **implemented + smoke** (tearing → short freeze). PR #194 |
| 2.6 | **shorten the freeze** = iOS bitrate cap (A) + IDR-on-drop (B) | shrink both ① congestion and ② IDR-wait of the freeze | ✅ **implemented + verified** — A: VT `AverageBitRate` 8Mbps (env; **DataRateLimits caused tearing → removed**). B: relay→agent `stream:request-idr`→swift stdin `0x01` force IDR. LAN: no tearing, short freeze |
| 2.7 | **codec negotiation + promote H.264 to default** | browsers without a decoder auto-fall back to JPEG → safe to default to H.264 | ✅ **implemented + tested** — browser `canDecodeH264()` → `device:boot acceptH264`, agent priority `env=jpeg > capability > default`. Default `TAPFLOW_IOS_CODEC` jpeg→**h264** (jpeg opt-out kept). Fallback target ~5% (old browsers without WebGL2). Unit tests ios +5, dashboard +5 |
| 3 | downscale the encode resolution | a triple win on bandwidth, CPU, latency | ☐ |
| 4 | event-driven/high-fps capture, optimize the touch path | shave the floor further | ☐ [#195](https://github.com/jo-duchan/tapflow/issues/195) (priority: low) |

### Foundation (done/in progress)
- H.264 encoder (VideoToolbox, baseline, MaxFrameDelayCount=0, steady cadence, BT.709) — ios-agent, now the **default** `TAPFLOW_IOS_CODEC=h264` (jpeg opt-out, promoted in 2.7).
- envelope codec/keyframe marker (byte5) — for relay keyframe-aware dropping (PR-D, **unblock — next step**).
- decoder layer `pickDecoder` (WebCodecs/MSE) + IOSViewer shows video directly + WebCodecs multi-NAL decode.

---

## 6. How to measure (reproduce)

```bash
TAPFLOW_STREAM_METRICS=1 TAPFLOW_IOS_CODEC=h264 pnpm dev     # H.264
TAPFLOW_STREAM_METRICS=1                       pnpm dev     # JPEG (default)
TAPFLOW_STREAM_METRICS=1 TAPFLOW_JPEG_QUALITY=0.95 pnpm dev  # JPEG quality comparison
```

| Where to read | Log | Meaning |
|---------|------|------|
| **ios-agent** | `stream metrics ... NNfps NNKB/s avg=NNKB drop=N%` | encoder output (cause) — bandwidth, average frame |
| **relay** | `ws backpressure: N frame(s) dropped` | actual LAN drops (effect). Drops are on the relay→browser hop |

#### per-stage latency panel (step 0)

In the browser, open the perf overlay with `?perf=1` (toggle `Ctrl+Shift+P`). The `tweakpane` `p50/p95 ms` folder shows **glass→glass · decode→present · agent→relay** live. The `Log latency summary` button prints a summary (JSON) of the current accumulated trace to the console, to paste into the §4 table. `Export trace` exports a `chrome://tracing`-compatible trace.

```bash
# Step-0 analysis on localhost (single clock). Vite :3001 = DEV build, so instrumentation is on.
TAPFLOW_IOS_CODEC=h264 pnpm dev   # :3001?perf=1 → H.264 per-stage
                       pnpm dev   # :3001?perf=1 → JPEG baseline
```

> ⚠️ **Instrumentation is DEV-build only** (`import.meta.env.DEV`). It is on only in the Vite dev server (`:3001`), **not in the built LAN (`:4000`)**. Step 0 is a localhost single-clock analysis, so `:3001` is exactly the right environment — glass→glass is valid only here.

#### force a decoder tier (dev override)

The URL query `?decoder=` forces a decoder so you can **compare tiers on localhost (single clock + panel)** (no non-secure LAN context needed). IOSViewer reads it only in DEV and logs the chosen decoder to `[decoder] using <…>`.

```
http://localhost:3001?perf=1                 # auto-select (localhost = WebCodecs)
http://localhost:3001?perf=1&decoder=mse     # force MSE (measure the LAN tier)
```

> MSE **buffers** rather than dropping, so the FIFO tracker (submit↔present) is accurate 1:1 — trustworthy even without WebCodecs's exact timestamp matching. (When WASM is added, `?decoder=wasm` enters the same point.)

> **LAN testing note:** the LAN (`:4000`) relay serves the built `packages/relay/public/`. Dashboard source changes need `pnpm --filter @tapflowio/dashboard build` then a `:4000` refresh to apply (Vite `:3001` is localhost-only).

---

## 7. Decision log (accumulated chronologically)

- **2026-06-03 — codec negotiation + promote H.264 to default:** WASM brought every path to the goal by measurement, but the encoder default was still JPEG. Simply defaulting to H.264 would give **a black screen on browsers without a decoder** (the agent sends H.264 one-way, no negotiation). → **Negotiate the codec up front** first: the browser decides via `canDecodeH264()` (= the same conditions as `pickDecoder`, evaluating capability only without creating an instance) and sends `acceptH264` in the `device:boot` payload → the agent decides the codec by priority **`env=jpeg` > `acceptH264` > default** (stored in `DeviceState` → same codec on reconnect). A missing field (version skew) = safe JPEG fallback. The relay forwards the payload as `unknown` (zero changes). **Research (caniuse): H.264 possible ~95% (WebGL2 is the floor), fallback needed ~5% (iOS14↓, IE11/legacy Edge, Chrome56↓)** — caught deterministically 100% by up-front feature-detect → **a runtime decode-failure fallback is over-investment, so Out of Scope.** Then **promote the default**: `TAPFLOW_IOS_CODEC` default `jpeg`→`h264`, `=jpeg` opt-out kept. The JPEG path (MjpegStreamer, createImageBitmap, relay's JPEG=keyframe assumption) is fully preserved. Unit tests ios +5 (codec-decision branches), dashboard +5 (`canDecodeH264`); ios 158, dashboard pickDecoder 13 pass; both packages tsc·lint pass. In the PR-D smoke, tearing was gone but a **short freeze (felt as lag)** remained after a drop. Diagnosis: freeze = ① **persistent congestion** (no bitrate cap on the iOS encoder → a ~20Mbps scroll burst exceeds the LAN → sustained backpressure) + ② **waiting for the next IDR** (2s period). **A:** VideoToolbox `AverageBitRate` + `DataRateLimits` cap (`TAPFLOW_IOS_H264_BITRATE`, default 8Mbps = same as Android) → reduces the congestion itself. **B:** when the relay's keyframe-aware sender recovers buffer but has no keyframe, `onWantKeyframe` → the relay sends the agent `stream:request-idr` (throttle 500ms) → ios-agent → swift stdin `0x01` → forces an IDR on the next frame (reusing the existing ForceKeyFrame) → once congestion clears, re-syncs ~immediately (removing the 2s wait). Android uses the scrcpy protocol so IDR requests aren't supported (the message is ignored, harmless). Unit tests +2 (onWantKeyframe); all packages tsc/lint·tests pass (agent-core 23, relay 168, ios 153). swift recompiled. **Device verification (2026-06-03): freeze gone. But `DataRateLimits` (a hard cap) caused frame corruption (tearing) under high motion → removed it, keeping only `AverageBitRate` (a soft target).** Re-verified: no tearing, short freeze. Lesson: **no hard bitrate cap (DataRateLimits), only AverageBitRate.**
- **2026-06-03 — PR-D relay drop-to-keyframe:** Fixes the LAN scroll tearing exposed by the WASM (zero-buffer) switch. The relay's drop-to-latest (`sendBinaryWithBackpressure`) corrupts H.264 up to the next IDR if it drops a P-frame → introduced a per-session **`createKeyframeAwareSender`** (agent-core/stream.ts): once it drops under backpressure, it **drops everything until the next keyframe (IDR) can be sent** → the decoder never receives a P referencing a broken chain (re-syncs via IDR within 1–2s instead of tearing). Keyframe detection uses the **envelope byte5 flag** (zero NAL parsing). JPEG/no-envelope = always a keyframe → existing drop-to-latest is preserved identically. agent-core unit tests 7 (state machine), relay tsc/168 tests pass. **Verification remaining: reproduce LAN scroll (tearing → short freeze).** (Optional follow-up: shorten recovery by re-requesting an IDR from the agent on drop via `stream:request-idr` — currently relies on the periodic IDR.)
- **2026-06-03 — 2-tier decoder simplification (MSE fully removed, PR#2):** Direction settled — **HTTPS→WebCodecs / HTTP→WASM, iOS·Android identical pipeline.** Deleted MSEDecoder, createJMuxer, jmuxer.d.ts, the jmuxer dependency; `pickDecoder` drops the createMuxer argument and is 2-tier (secure→WebCodecs, else wasm-capable→WASM, else null). Both viewers call `pickDecoder()` with no argument. **Force Android baseline** (`ScrcpySession` video_codec_options `profile:int=1`) — required once the MSE safety net is removed since WASM is baseline only. (The pinned `OMX.google.h264.encoder` is a software encoder so it's likely already baseline — pinning it explicitly crystallizes the decision. Emulator smoke needed to confirm the encoder accepts the profile option.) dashboard 169 tests·tsc·build pass. **Smoke PASS (2026-06-03):** ① localhost iOS `[sps-vui] profileIdc:66` + decode→present 2.3ms held ② scrcpy accepts `profile:int=1` and streams fine ③ **on plaintext HTTP at :4000, Android (1080×2424) renders fine via WASM = indirect proof of baseline**, iOS fine too. **Finding:** on iOS scroll, relay `ws backpressure` drops → **intermittent screen tearing** (WASM has no buffer so drops are more exposed than MSE). Not a regression from this PR = H.264 corruption from relay drop-to-latest. → **PR-D (drop-to-keyframe) unblocked** (MSE exit complete) = next step.
- **2026-06-02 — step-2 WASM done + measurement gate PASS (goal reached):** PR#1 (R1–R3 + R5 override) implemented — `tinyh264@0.0.7` (baseline, I/P only; wasm inlined as a data-URI = no separate asset) + `WASMDecoder` (worker-encapsulated, transfers the AU as-is) + a new `YUVWebGLRenderer` (I420 3-texture BT.709 limited) + IOSViewer `?decoder=wasm` override. Unit tests 17, full suite 183 pass, `vite build` worker chunk 173KB verified. **localhost `?perf=1&decoder=wasm` measured: decode→present still 8.7/p95 30.4, scroll 14.3/p95 37.9; glass→glass still 9.6, scroll 16ms.** **~27x·~16x↓** vs MSE (239/229), on par with localhost-JPEG (12.4/9.4) — **goal achieved on the non-secure path.** Color and feel good, CPU headroom (localhost = worst case). → **Q4: downscale confirmed not needed.** Next: pickDecoder flip (R4=PR#2) to make WASM the non-secure default.
- **2026-06-02 — H.264 migration (Phase 2):** Confirmed the JPEG full-frame bandwidth problem (still 3.3MB/s, LAN scroll drops 16–27/s) → introduced VideoToolbox H.264. Bandwidth solved ~140x (still) / ~5x (scroll), drops nearly eliminated.
- **2026-06-02 — but latency discovered:** H.264 is **slower to respond than JPEG** due to the codec pipeline + the LAN MSE buffer. Established localhost-JPEG as the "feels-like-direct" bar. → Redefined the real task as **"a low-latency decode/transport path"**, not "switching to H.264".
- **2026-06-02 — work begins:** Tackle bottlenecks one at a time, measurement-driven. The WASM decoder (tier1 LAN-HTTP) is the key lever. PR-D (drop-to-keyframe) held off given a possible MSE exit.
- **2026-06-02 — step-2 WASM plan locked (design decision):** Wrote the implementation plan (`.work/2026-06-02-wasm-tinyh264-decoder-plan.md`, local). Key decisions: ① **decoder-agnostic boundary** — encapsulate the concrete decoder behind `WASMDecoder` (a Decoder impl) + the new `YUVWebGLRenderer`. **tinyh264 is the first candidate but not a lock-in**: since we own the encoder = VideoToolbox baseline, a baseline-only decoder constraint is moot, and at a full-res CPU ceiling we can swap only the decoder for a SIMD build (ffmpeg.wasm/OpenH264) with the renderer/pickDecoder unchanged. ② **can't reuse the existing `WebGLVideoRenderer`** — `texImage2D(VideoFrame)` is WebCodecs=secure-only, but the WASM tier exists precisely for non-secure, and tinyh264 outputs I420 YUV → **a new Y/U/V 3-texture BT.709 shader renderer is needed** (the latency win comes not from inside the decoder but from the absence of the `<video>` buffer → structural, decoder-independent). ③ **PR = option A (2 PRs)** — PR#1 = the whole implementation behind the `?decoder=wasm` dev override only (pickDecoder unchanged = zero production impact, gate-measure here), PR#2 = the pickDecoder flip (non-secure → WASM first) **only after the gate passes.** If R1 (wiring Vite .wasm + worker assets) blocks, split it out first. ④ Q4 (full-res CPU sequencing: downscale/SIMD-swap/rollback) = **decided after the R5 gate measurement.** → **Next: start R1.**
- **2026-06-02 — MSE measured → WASM justified (entering step 2):** After the reorder=0 fix applied to every decoder, measured the MSE path on localhost (single clock) via the `?decoder=mse` dev override → decode→present p50 **~235ms** (vs WebCodecs ~2.5ms). With jmuxer `flushingTime:0` already applied, this is the `<video>` media-element buffer = **structural and MSE-inherent** (unrelated to SPS/reorder). MSE buffers rather than dropping, so the FIFO tracker is accurate (no drift). → Data confirms **tier1 LAN-HTTP can't reach the goal with MSE** → **started WASM** (no media element, no buffer, no secure context needed). dev decoder force: IOSViewer `?decoder=mse|webcodecs` (when WASM is added, `wasm` at the same point).
- **2026-06-02 — step-1 encoder migration done:** Moved the SPS reorder=0 rewrite **into ios-agent** (`agent-core/utils/sps.ts` canonical, only keyframe SPS via `rewriteLowLatencySpsInFrame`). The encoder declaring reorder=0 at the source benefits **every path — WebCodecs, MSE, and future WASM**. localhost e2e confirmed: the browser `[sps-vui]` shows `bitstreamRestriction:true, maxNumReorderFrames:0` (receiving the agent's rewrite), decode→present p50 2.2ms held. The browser copy is a defensive line (no-op). **Next (entering step 2): measure residual MSE latency** — after `pnpm --filter @tapflowio/dashboard dev --host`, from the Mac open `http://<mac-LAN-IP>:3001?perf=1` (non-secure→MSE, same device→single clock) to measure how much MSE media buffer remains → decide the WASM investment.
- **2026-06-02 — step-0 analysis done + step-1 verified (key progress):** Pinned the cause of the ~267ms localhost-WebCodecs-H.264 latency — transport/relay (~1ms) and input backlog (queueSize=0) are clean, **the decoder buffers max DPB (~8 frames)**. SPS VUI parsing confirmed `bitstreamRestriction:false` (Level 5.0) → the encoder doesn't tell the decoder "reorder 0", so it assumes the worst. It's baseline so the actual reorder is 0 — **a pure missing signal**. **Fix:** WebCodecsCore injects `max_num_reorder_frames=0` / `max_dec_frame_buffering=num_ref` into the SPS just before configure (`rewriteSpsLowLatency`). **Result: decode→present 267→2.5ms (~100x), glass→glass 235→3.5ms, feel reaches localhost-JPEG-class.** (Only the WebCodecs path at this point — later widened to all paths via the encoder migration; see the entry above.)
- **2026-06-02 — step-0 instrumentation begins:** **Reused** the existing `perf` system (`?perf=1`, FrameTiming, trace export) (discarding a new sampler). The key gap was the H.264 path logging `decodeMs/paintMs=0` — fire-and-forget to the decoder surface left the analysis target in a blind spot. Fix: added `onDecodedFrame` to Decoder (WebCodecs = output callback, MSE = `requestVideoFrameCallback`) + a `FrameLatencyTracker` (submit↔present FIFO correlation, **accurate because baseline·B-frame OFF means no reordering**) to recover decode→present and glass→glass. glass→glass is epoch present−capturedAt, so it's only computed **on a localhost single clock**. Protocol/envelope unchanged; the interface change is internal to the dashboard (non-breaking). Measured numbers accumulate in §4.
