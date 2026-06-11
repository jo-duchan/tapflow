# Why the legacy-browser (5%) fallback is iOS-only

> This document records *why* the JPEG fallback for old/unsupported browsers (~5%, no WebGL2)
> exists only on iOS and not on Android. It is a rationale note — read it before "fixing" the
> asymmetry (e.g. deleting the iOS JPEG path, or adding a JPEG fallback to Android).

---

## Conclusion (TL;DR)

The asymmetry is **historical, not a bug**:

- tapflow started with **iOS = JPEG**, **Android = H.264** (scrcpy). The two platforms began on opposite codecs.
- iOS later migrated **JPEG → H.264** for bandwidth. The JPEG path was **kept, not deleted** — it became the fallback for browsers that can't decode H.264.
- Android never had a JPEG capture path to begin with, so there is nothing to fall back to. A no-H.264 browser on Android simply shows an "unsupported" message.

So the legacy-browser floor is iOS-only because **only iOS already owned a JPEG pipeline** when H.264 became the default. It costs ~0 to keep, and it covers the ~5% for free — that is why it stays.

---

## 1. The two platforms started from opposite codecs

- **Android** has always been H.264. It streams over two backends — scrcpy (real devices) and the gRPC host-encode path (emulators) — both emitting H.264 access units. There is **no JPEG capture path** in the Android live stream. (The only `jpeg` reference in `android-agent` is the on-demand `screenshot:request` still capture, not the stream.)
- **iOS** started as JPEG: SimulatorKit IOSurface → `encodeJPEG` → WebSocket binary frames, rendered in the browser via `createImageBitmap`.

## 2. The iOS JPEG → H.264 migration, and where the env knob came from

H.264 was added to iOS to cut bandwidth (especially on LAN). The migration shows up cleanly in git history:

- **`fb9e02d`** `feat(ios-agent): VideoToolbox H.264 encoder (opt-in via TAPFLOW_IOS_CODEC)` — the VideoToolbox H.264 encoder, the iOS `CODEC_H264` path, and the `TAPFLOW_IOS_CODEC` env knob were **all introduced in this one commit**. At this point H.264 was **opt-in** (JPEG was still the default), and the knob was a **performance-debugging switch** for comparing the new encoder against JPEG.
- **`bd113d1`** `feat(ios-agent): negotiate H.264 decode capability, default to H.264` — the default flipped to H.264, and per-browser capability negotiation (`acceptH264`) was added. From here the knob's meaning inverted: it is now an **opt-out** (`TAPFLOW_IOS_CODEC=jpeg` forces JPEG).

So `TAPFLOW_IOS_CODEC=jpeg` is **not** a pre-H.264 vestige — before H.264, JPEG was the only path and needed no toggle. The knob was born with H.264. Its *original* purpose (gating opt-in to the new encoder) is obsolete now that H.264 is the default; today it survives as a force-JPEG debug escape hatch.

Current semantics (`packages/ios-agent/src/IOSAgent.ts`):

```ts
const envAllowsH264 = process.env.TAPFLOW_IOS_CODEC !== 'jpeg'   // default H.264; =jpeg forces JPEG
const useH264 = this.intervalMs === undefined && envAllowsH264 && state.acceptH264
```

## 3. Why JPEG survived on iOS — it's the legacy-browser floor

"Can this browser decode H.264?" is decided by `canDecodeH264()` in `packages/dashboard/lib/decoders/pickDecoder.ts`:

```ts
(secureContext && webCodecs && webgl2) || (wasm && webgl2)
```

WebGL2 is the floor (~95% of browsers); the remaining ~5% (no WebGL2) can decode neither WebCodecs nor WASM (tinyh264). The dashboard sends the result to the agent as `acceptH264` at `device:boot`.

On iOS, `acceptH264 === false` makes `useH264` false → the agent streams JPEG → the browser renders it through the existing iOS JPEG pipeline (`onJpegFrame` in `useDecoderStream`, `createImageBitmap` in `IOSViewer`). Because the JPEG pipeline was **already there** from the pre-migration era, covering the ~5% cost almost nothing — so it was kept rather than removed.

## 4. Why Android has no equivalent fallback

- `acceptH264` is **only consumed by `ios-agent`** — `android-agent` ignores it entirely and always streams H.264.
- `AndroidViewer` has **no `onJpegFrame` handler** (it's commented "Android is H.264-only, so no JPEG handler"); `onJpegFrame` is documented "iOS-only" in `useDecoderStream`. This is harmless: since the Android agent never emits JPEG, no JPEG frame ever reaches the viewer.
- When `pickDecoder()` returns `null` (no WebGL2), `AndroidViewer` shows an unsupported message instead of a stream:
  > 이 환경에서는 스트리밍을 표시할 수 없습니다. Chrome/Edge 또는 HTTPS 환경에서 다시 시도해 주세요.

So on the ~5% browsers: **iOS keeps streaming via JPEG; Android shows the unsupported notice.** That is the entire user-visible asymmetry.

## 5. Decision: keep as-is

Deleting the iOS JPEG path to "symmetrize" the platforms would require removing **all** of:

1. the ~5% legacy-browser fallback — a product decision to drop low-spec browser support;
2. the `TAPFLOW_IOS_CODEC=jpeg` opt-out — a documented env flag (removing it is a breaking change);
3. the `intervalMs`/`MjpegStreamer` JPEG mode — a supported `IOSAgentOptions` runtime option that the production entrypoint never passes, so `MjpegStreamer` runs only in tests (or when `intervalMs` is set explicitly); its code and tests still exist.

The reverse direction — adding a JPEG capture path to Android to match iOS — is expensive (Android has no such pipeline) for ~5% of browsers.

Both are net-negative. The JPEG fallback is a near-zero-cost asset iOS already owns, and it covers the ~5% for free. **Leave it in place.**

---

## Related code

- `packages/dashboard/lib/decoders/pickDecoder.ts` — `canDecodeH264()` / `pickDecoder()` (the ~5% floor)
- `packages/dashboard/hooks/useDecoderStream.ts` — `onJpegFrame` ("iOS-only"), `onUnsupported`
- `packages/dashboard/components/device/IOSViewer.tsx` — JPEG render path (`createImageBitmap`)
- `packages/dashboard/components/device/AndroidViewer.tsx` — no JPEG handler; unsupported notice
- `packages/ios-agent/src/IOSAgent.ts` — `envAllowsH264` / `useH264` / `acceptH264`
- `packages/ios-agent/AGENTS.md` — `TAPFLOW_IOS_CODEC` env documentation
