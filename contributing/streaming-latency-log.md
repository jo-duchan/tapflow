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

### render/decode isolation (spike a — measured 2026-06-06, localhost `?perf=1&decoder=wasm`)

Isolated `drawI420` (GPU plane upload + YUV→RGB shader) from the worker decode+transfer
portion of the WASM `decode→present`, to locate the bottleneck before an openh264-wasm swap.
`[wasm-render]` (WASMDecoder DEV diag) logs drawI420 duration; the panel's `Log latency
summary` gives the full-session decodeMs. iOS path (only viewer with `?decoder=wasm`).

| Phase | decodeMs p50/p95/max (full) | drawI420 p50/p95 (render) | glass→glass p50/p95 |
|-------|----------------------------:|--------------------------:|--------------------:|
| still (n=1090)  | **8.6 / 18.8 / 64.8** | **~0.25 / ~0.5** | 9.7 / 23.0 |
| scroll (n=996)  | **12.7 / 26.3 / 96.5** | **~0.20 / ~0.5** | 14.4 / 28.8 |

→ **Render is ~2–3% of decode→present** (drawI420 p50 ~0.25ms vs decodeMs p50 8.6–12.7) and
**content-independent** — flat still↔scroll, while decodeMs rises with motion (p50 +4.1, p95
+7.5). So the scroll increase and the entire p95/max tail are **decode+transfer, not render**.
**Conclusion: the WASM bottleneck is the software decode (h264bsd, scalar) — renderer ruled
out.** Justifies the openh264-wasm spike; gate = shrink the decode p95 tail. The renderer is
shared across decoders, so this isolation transfers (a swap's gate = decodeMs − ~0.5ms render).

### FFmpeg-h264 (scalar wasm) vs tinyh264 — engine probe (c-0, measured 2026-06-07, localhost)

Probed whether a "better-engineered" decoder (FFmpeg h264, libavcodec) beats tinyh264
(h264bsd) on the non-secure WASM tier. Built FFmpeg n5.1.2 `--disable-asm` (scalar) to wasm,
wired behind `?decoder=ffmpeg` reusing WASMDecoder/YUVWebGLRenderer (packed I420 via
av_image_copy_to_buffer). Both measured same session (machine state drifts, so the tinyh264
baseline was re-measured alongside, not reused from the spike-a numbers above).

| metric | tinyh264 (fresh) | FFmpeg | delta |
|--------|-----------------:|-------:|------:|
| still p50/p95  | 10.2 / 22.5 | **8.7 / 13.4** | p95 **−40%** ✓ |
| scroll p50/p95 | 14.8 / 27.2 | **16.3 / 29.7** | p95 **+9%** ✗ |

→ **Mixed, not a clear win.** FFmpeg crushes the *still* p95 tail (13.4 vs 22.5) but is
slightly *worse* on *scroll* (the high-motion case that matters most) on both p50 and p95.
Confirms the earlier thesis: FFmpeg's native lead is asm-derived; stripped to scalar C in
wasm, it doesn't beat the leaner baseline-only h264bsd on heavy P-frame/motion-comp loops.
**By the success gate (shrink the scroll p95 tail), FFmpeg-scalar fails.** Caveats before a
verdict: (1) the FFmpeg *core* was built without explicit `-msimd128` (only the glue + final
LTO link had it) — autovectorizing the decode hot loops is an untested lever; (2) the packed
repack adds one extra heap memcpy/frame vs tinyh264 (minor scroll handicap). Next: rebuild
FFmpeg core with `-msimd128` as the decisive test before accepting/rejecting the engine swap.

**Follow-up — FFmpeg core rebuilt WITH `-msimd128` (`--extra-cflags`, 2026-06-07):** the
SIMD autovectorization flipped the scroll result. FFmpeg now beats tinyh264 on *all four*:

| metric | tinyh264 | FFmpeg (no SIMD) | **FFmpeg +SIMD** | vs tinyh264 |
|--------|---------:|-----------------:|-----------------:|------------:|
| still p50/p95  | 10.2 / 22.5 | 8.7 / 13.4 | **8.5 / 12.9** | p95 **−43%** |
| scroll p50/p95 | 14.8 / 27.2 | 16.3 / 29.7 | **11.7 / 25.5** | p50 **−21%**, p95 **−6%** |

→ `-msimd128` cut scroll p50 16.3→11.7 (−28%) — the heavy motion-comp/IDCT loops *do*
autovectorize. **Gate passes (scroll p95 25.5 < 27.2).** Validates the original "WASM SIMD"
thesis, but narrowly: needs a decoder whose C loops autovectorize (FFmpeg) **plus** explicit
`-msimd128` on the core. Verdict so far: FFmpeg+SIMD is faster everywhere — strongest on still
p95 (−43%) and scroll p50 (−21%); scroll p95 (the hardest tail) only −6%. **Open cost question:
1.9MB worker vs tinyh264's 173KB (11×).** Before committing, test whether tinyh264+`-msimd128`
(spike b) closes the gap at 1/11 the size — SIMD now demonstrably matters, so b is freshly
motivated (was predicted marginal; worth an empirical check).

**openh264 instead of b (2026-06-07):** skipped b (h264bsd is not perf-engineered → low
ceiling) and built openh264 v2.4.1 decoder-only to wasm (`--disable asm` = scalar C++, all
sources `-msimd128`) as the "good engine + compact" candidate to dethrone FFmpeg. Compiled the
decoder/common .cpp directly with em++ (skip the Makefile's platform/asm machinery) + a
`decode_to_i420` glue (ISVCDecoder → packed I420), reusing the same worker/renderer. Artifact
**557KB** — 3.4× smaller than FFmpeg's 1.9MB (compact claim ✓). But on speed:

| metric | tinyh264 (173KB) | FFmpeg+SIMD (1.9MB) | openh264+SIMD (557KB) |
|--------|-----------------:|--------------------:|----------------------:|
| still p50/p95  | 10.2 / 22.5 | **8.5 / 12.9** | 9.2 / 17.8 |
| scroll p50/p95 | 14.8 / 27.2 | **11.7 / 25.5** | 18.4 / 32.9 |

→ **openh264 is the *worst* of the three on scroll** (18.4/32.9 — slower than even tinyh264),
better than tinyh264 only on still. The "good engine + compact = best of both" thesis **fails
empirically**: openh264's scalar-C fallback (+`-msimd128`) doesn't autovectorize/optimize like
FFmpeg's, and on heavy motion it trails the simple h264bsd. **openh264 eliminated (dominated:
bigger than tinyh264 yet slower on scroll; smaller than FFmpeg yet slower everywhere).**

**Decision reduces to FFmpeg+SIMD vs keeping tinyh264** — a size/maintenance vs speed call:
FFmpeg wins decode (still p95 −43%, scroll p50 −21%, scroll p95 −6%) at 11× the bundle (1.9MB,
one-time load, non-secure tier only) plus a custom ffmpeg-wasm build to maintain; tinyh264 is
173KB and a plain npm dep. No clear dominant — a product judgment on whether the (mostly
still/scroll-p50) latency win is worth the size + build-maintenance cost.

**spike b finally measured — tinyh264+`-msimd128` (2026-06-07):** rebuilt h264bsd with
`-msimd128` (emsdk 3.1.51), vendored, `?decoder=tinysimd`. Result: still 10.8/27.4, scroll
16.5/32.5 — **no better than (slightly worse than) the plain npm tinyh264** (10.2/22.5,
14.8/27.2). **h264bsd's C does not autovectorize** — `-msimd128` only added codegen overhead.
Confirms the prediction; b eliminated. (Caveat: the npm baseline used a different emsdk, so
part of the regression is version noise — but even best-case b ≈ plain tinyh264, nowhere near
FFmpeg.) Full four-way (localhost, decode→present ms):

| metric | tinyh264 (173KB) | tinyh264+SIMD (159KB) | openh264+SIMD (557KB) | FFmpeg+SIMD (1.9MB) |
|--------|-----------------:|----------------------:|----------------------:|--------------------:|
| still p50/p95  | 10.2 / 22.5 | 10.8 / 27.4 | 9.2 / 17.8 | **8.5 / 12.9** |
| scroll p50/p95 | 14.8 / 27.2 | 16.5 / 32.5 | 18.4 / 32.9 | **11.7 / 25.5** |

→ **Exhaustive result: FFmpeg+SIMD is the *only* decoder that beats plain tinyh264 on every
metric.** Both "compact + fast" hopes failed (openh264 dominated; SIMD doesn't help h264bsd). So
the final choice is genuinely binary — **FFmpeg+SIMD (fastest, 1.9MB, custom build) vs keep
tinyh264 (good-enough, 173KB, npm dep)** — with no free lunch in between. Decode bottleneck
remains the lever (render isolated at ~0.5ms throughout). Pending: product decision + real-LAN
re-measure (these are localhost single-clock; remote LAN runs the decoder on a separate Mac
with different CPU headroom, which may widen or narrow the FFmpeg gap).

### real-LAN re-measure (W2 — measured 2026-06-07, host MacBook → remote Mac mini, `:3001` cross-machine)

Decoder runs on the **Mac mini's** CPU over a real LAN hop (glass→glass null = two clocks;
decode→present valid). Same `?decoder=ffmpeg` vs `?decoder=wasm`:

| metric | tinyh264 | FFmpeg+SIMD | delta |
|--------|---------:|------------:|------:|
| still p50/p95  | 11.4 / 43.4 | **10.2 / 33.8** | ffmpeg −11% / **−22%** |
| scroll p50/p95 | **15.3** / 53.0 | 17.6 / 53.3 | ffmpeg **+15%** / ~tie |

→ **The localhost FFmpeg scroll win did NOT hold on real LAN — it reversed.** ffmpeg still wins
*still* (idle smoothness) but is *slower* on *scroll* p50 (the stress case) and tied on scroll
p95. And **both decoders' scroll p95 blew up to ~53ms** (vs ~25–27 on localhost) — the real
tier1 gap is **largely decoder-independent**. Read: FFmpeg's `-msimd128` win is **CPU-dependent**
(helped the MacBook, not the Mac mini), and remote viewers are uncontrolled heterogeneous
hardware. **Verdict: W2 does not justify adopting FFmpeg** — an idle-only, hardware-dependent
win is not worth 11× bundle + a custom build to maintain. **Keep tinyh264; do not flip
pickDecoder.** The ~53ms scroll-p95 (shared by both) points to **load-reduction levers
(downscale, H.264 static-skip) over a decoder swap.** (Caveat: single ~960-frame runs; scroll
p50 gap is median-robust, p95 noisier.)

**Confirmed — paired 4-round re-measure (2026-06-07, Mac mini, ~950 frames each):** variance
turned out tiny, so the trade-off is real, not noise. Means over 4 rounds:

| metric | tinyh264 | FFmpeg+SIMD | winner (4/4 rounds) |
|--------|---------:|------------:|:-------------------|
| still p50/p95  | 11.3 / 43.9 | **9.8 / 33.0** | **ffmpeg** (−13% / −25%) |
| scroll p50/p95 | **16.6 / 49.9** | 18.5 / 53.5 | **tinyh264** (ffmpeg +11% / +7%) |

Every round split the same way: **ffmpeg wins idle (still), tinyh264 wins motion (scroll)** —
per-round scroll deltas all favor tinyh264 (p50 −1.1…−2.9, p95 −0.8…−5.0). Per the
pre-registered rule (adopt ffmpeg only on a consistent scroll win, given its 11× bundle +
custom-build cost), **ffmpeg is rejected: it loses the scroll case (the interaction
responsiveness that defines "feels-direct") in all 4 rounds.** **DECISION: keep tinyh264;
W1 ffmpeg package removed.** (Likely cause of the scroll loss: ffmpeg's repack memcpy +
heavier per-frame path on a bandwidth-bound machine vs h264bsd's lean baseline path.) Scroll
p95 ~50ms on **both** (vs ~25 localhost) reconfirms the real gap is **load/transport, not the
decoder** → next levers: H.264 static-skip (iOS) + downscale.

### Android bottleneck localize (2026-06-07, localhost, Pixel_9 emulator 1080×2424)

First Android measurement on the shared perf harness (AndroidViewer now uses useDecoderStream
→ decode→present + recv fps). `TAPFLOW_STREAM_METRICS=1` gives agent `fpsSent`.

| phase | agent fpsSent | drop | relay bp | decode→present p50/p95 (WebCodecs) |
|-------|--------------:|-----:|---------:|----------------------------------:|
| still  | 6 → **0** | 0% | 0 | 2.2 / 3.7 (n=30) |
| scroll | **~22–29** (avg ~25, max 28.8) | 0% | 0 | 1.8 / 2.6 |

→ **Android is source/encode-bound, not decode/transport.** Idle = 0 fps (scrcpy is
surface-driven — already a static-skip equivalent). Under scroll the agent only produces
~22–29 fps (can't sustain the 30 cap) while **decode is trivial (1.8ms) and there are zero
drops/backpressure** — i.e. the emulator's software H.264 encoder + QEMU is the limit on frame
production, not the pipeline downstream. (Plus QEMU's own input→render latency, unfixable
downstream.) **Android lever = reduce the emulator encoder's pixel load** — preferably a lower
**AVD native resolution** (no scaling step) over scrcpy `max_size` (whose earlier 30→4fps
backfire was GPU-bound scaling, but under a possibly zombie-polluted session → re-measure
clean). Decode/transport levers (a faster decoder, noDelay) would not help Android here.

### Android host-encode feasibility spike (W7, 2026-06-07, emulator gRPC streamScreenshot)

Confirmed the emulator has **no hardware H.264 encoder** (`list_encoders`: only `c2.android.avc.encoder (sw)`; `OMX.google.h264.encoder` is an alias of it; h265/av1 also sw). So scrcpy (guest MediaCodec) is capped at the software encoder. Probed the host-side raw-capture path — the emulator gRPC `streamScreenshot` (relaunched with `-grpc 8554`, unprotected; what Android Studio's embedded emulator uses) — with continuous scroll, native 1080×2424 RGBA8888:

```text
recvFps 59.6 · producedFps(seq) 60.1 · droppedBeforeUs 5/602 (0.8%)
avgFrame 10.2MB · throughput 596 MB/s (loopback) · interFrame p50 17.4 / p95 19.6 ms
```

→ **Key insight: the emulator renders at 60fps; the ~22–29fps we saw via scrcpy was purely the
guest software H.264 encoder.** Raw capture over gRPC delivers full 60fps native with ~0% drops
(naive bytes transport, no shared-mem needed) on macOS. **W7 (capture raw via gRPC → encode on
the Mac with VideoToolbox, reusing the iOS encoder) is strongly viable** — capture is not a
bottleneck, and VT hardware-encodes 1080p@60 trivially. Would make the Android emulator iOS-class
(or better, 60fps). Remaining: RGBA→CVPixelBuffer→VTCompressionSession→Annex B→envelope, and the
input path (gRPC sendTouch/sendKey vs keep scrcpy control).

### Android host-encode — implemented + payoff (W7, 2026-06-07, emulator gRPC → Mac VideoToolbox)

Built the backend: TS `EmulatorGrpcClient` (grpc-js) captures RGBA via `streamScreenshot`; pipes to
a host-side Swift VT encoder (`emulator-encoder`, reusing the iOS VT config — baseline, B-off,
MaxFrameDelay=0, BT.709, 8Mbps soft) → Annex B → same TFFE envelope as scrcpy. Input via gRPC
`sendTouch` (display-resolution px, top-left origin). Continuous scroll, encoded fps out of the agent:

```text
native 1080×2424   : encodedFps 34.3 · avgFrame 5.3KB · 1.5 Mbps
downscale 712×1600 : encodedFps 59.4 · avgFrame 2.7KB · 1.3 Mbps   (server-side resize, W3 free)
```

→ **scrcpy scroll 22–29fps (guest SW encoder) → gRPC+VT 59.4fps downscaled (2×+, near 60).** The
native 34fps cap is **pixel-volume bound** (10MB/frame gRPC recv + pipe + R/B swizzle = the predicted
B-architecture copy cost); downscale resolves it. The gRPC `streamScreenshot` is **frame-driven**
(idle = 0 frames = free static-skip; iOS needs an explicit seed-skip). Orientation: the stream is
delivered **top-down** (proto's "bottom up" note is pre-orientation-transform — verified visually),
so no flip; only R↔B swizzle for the BGRA pixel buffer VT wants.

**Default policy (2026-06-07):** emulators auto-select the gRPC backend (`pickAndroidBackend`),
**capped at 30fps** (iOS parity) — at 60fps the LAN-HTTP WASM decoder pays 2× decode/transport, the
tier1 bottleneck; 30fps halves it. 60fps headroom stays available for localhost/LAN-HTTPS (WebCodecs
hw decode) via `TAPFLOW_ANDROID_FPS`. Real devices keep scrcpy (HW encoder); gRPC failure → scrcpy
fallback. **Auth:** a plain `-grpc <port>` endpoint is unsecured (localhost, = scrcpy's localhost adb
trust); the agent launches emulators with it. The default (no flag) gRPC port requires a token →
`UNAUTHENTICATED`, hence the agent owns the `-grpc` launch.

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
| 3 | downscale the encode resolution | a triple win on bandwidth, CPU, latency | ✅ **implemented + measured** — both platforms via `TAPFLOW_MAX_SIZE` (iOS vImage scale; Android gRPC server-side resize). Tuning data + recommended `1280`: [downscale-tuning.md](./downscale-tuning.md). Finding: **bandwidth floors at ~1280; below that only decode load drops (fidelity cost).** decode→present column pending (viewer-side WASM, manual overlay) |
| 4 | event-driven/high-fps capture, optimize the touch path | shave the floor further | ☐ [#195](https://github.com/jo-duchan/tapflow/issues/195) (priority: low) |

### Foundation (done/in progress)
- H.264 encoder (VideoToolbox, baseline, MaxFrameDelayCount=0, steady cadence, BT.709) — ios-agent, now the **default** `TAPFLOW_IOS_CODEC=h264` (jpeg opt-out, promoted in 2.7).
- envelope codec/keyframe marker (byte5) — for relay keyframe-aware dropping (PR-D, **unblock — next step**).
- decoder layer `pickDecoder` (WebCodecs/MSE) + IOSViewer shows video directly + WebCodecs multi-NAL decode.

---

## 6. How to measure (reproduce)

The full instrumentation reference — every emitter, exact output, the `?perf=1` panel, the `?decoder=` override, and the localhost vs cross-machine procedures — lives in **[`measurement.md`](./measurement.md)**. This campaign was driven by those tools: agent `TAPFLOW_STREAM_METRICS=1` throughput, relay `ws backpressure` drops, and the `?perf=1` per-stage panel (glass→glass · decode→present · agent→relay) on a localhost single clock.

---

## 7. Decision log (accumulated chronologically)

- **2026-06-08 — LAN scroll tearing has TWO independent causes (the key lesson):** While verifying the downscale tiers (localhost/LAN-HTTPS = native, LAN-HTTP = 1280, external = 1000; per-session from the viewer's `isSecureContext` + relay remote-IP classification), intermittent **"breaks vertically then recovers"** tearing remained on scroll. It turned out to be **two separate bugs that look identical**, needing separate fixes:
  - **① Orphan P-frame (transport drop).** A P-frame dropped under backpressure leaves the next P referencing a frame the decoder never got → the decoder (esp. WASM tinyh264, zero-buffer) shears until the next IDR. Fixed by **keyframe-aware backpressure** on every drop point: relay (`createKeyframeAwareSender`, already in place) **and** both agents' agent→relay pump (Android `ddd9eb1`, iOS `2c47798`) — once dropping, drop the whole GOP until an IDR, and throttled `request-idr` for fast resync. Reproduced + confirmed with the **real tinyh264** in a headless Chrome (not ffmpeg — different decoder, invalid as a proxy): orphan replay shears, drop-to-keyframe replay is clean.
  - **② Source IOSurface tear (capture race).** Even with ①  fixed, iOS still tore — **on native tier and on localhost (WebCodecs)**, which rules out drops, downscale, and the WASM decoder. Root cause: the simulator draws into a **single IOSurface in place**, asynchronously to our 30fps capture timer; reading it mid-draw bakes a horizontal tear into the H.264/JPEG frame (tier- and decoder-independent, recovers next frame). `IOSurfaceLock(.readOnly)` is cooperative → does **not** block the sim's GPU writes, so the existing lock didn't help. Fixed (`d37262f`) by **`copySurfaceStable`**: memcpy the surface to a private buffer bracketed by `IOSurfaceGetSeed`; if the seed moved during the copy, retry (budget 4). Applied to both encode paths. **Evidence: during heavy scroll ~40% of frames raced a write (`retries=24/60`), all resolved (`exhausted=0`)** — clean replay confirmed, 159 ios tests pass. See `ios-agent/AGENTS.md` → "Tear-free framebuffer snapshot".
  - **Methodology lesson:** **localhost masks LAN-HTTP bugs.** localhost is a secure context → WebCodecs (hardware, buffered, forgiving); LAN-HTTP → WASM tinyh264 (zero-buffer, baseline, unforgiving). Decode/transport artifacts that are invisible on localhost surface only on LAN-HTTP. Always reproduce streaming bugs on plain-HTTP LAN with the WASM tier, and verify with the **real** decoder (headless Chrome on the captured `.bin`), never a stand-in codec.
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
