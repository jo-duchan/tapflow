---
type: rationale
topics: [streaming, codec, browser-compat]
status: stable
related: [legacy-browser-fallback-ios-only, streaming-latency-log]
---

# Why the browser negotiates codec capability before the agent streams

> Read this before making the agent pick a codec on its own, or before removing the
> `acceptH264` capability field from `device:boot`. Without the negotiation, promoting
> H.264 to default gives a decoderless browser a black screen.

## The problem it prevents

The agent decides its codec when the stream starts and cannot switch mid-stream (the codec
is fixed in the streamer's constructor). Before this change there was no negotiation, so
the agent pushed H.264 unconditionally. Promoting the iOS default from JPEG to H.264 in
that world would have shown a black screen to every browser that cannot decode H.264.

## The capability floor

A browser decodes H.264 when it has either a secure context with WebCodecs, or WASM with
WebGL2. Because WASM + WebGL2 alone is enough, the fallback floor is set by WebGL2
(~95%), not by WebCodecs (~94%, only the secure hardware tier). So roughly 95% can take
H.264 and about 5% need the JPEG fallback. That 5% is old Safari, legacy Edge/IE11, and
pre-2017 Chrome, and since tapflow is an internal self-hosted tool the real exposure is
lower still. The [iOS-only legacy fallback](./legacy-browser-fallback-ios-only.md) is what
serves that 5%.

## Decisions

- **Pre-capability only, no runtime-failure fallback.** The 5% is almost entirely
  "no decoder at all," which feature detection catches deterministically before streaming
  (`pickDecoder() !== null`). The case of "capability says yes but the decode breaks at
  runtime" is rare enough that restarting the streamer for it would be over-investment; the
  `decoderFailed` latch stays a warning.
- **Ride an existing message, add no new type.** The browser sends `acceptH264` as an
  optional field on the existing `device:boot` payload, so relay's whitelist routing passes
  it unchanged. No new browser-to-agent message type.
- **Codec priority**: env opt-out (`TAPFLOW_IOS_CODEC=jpeg`) > browser capability > default.
- **A missing field means JPEG.** An older browser that omits `acceptH264` falls back to
  JPEG safely, which keeps the change non-breaking and the screen non-black.
- The field is platform-neutral by intent. Android is not negotiated (scrcpy is always
  baseline H.264), but the field can be reused by a future platform.
