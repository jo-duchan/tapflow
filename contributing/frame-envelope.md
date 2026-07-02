---
type: reference
topics: [streaming, protocol, instrumentation]
status: stable
related: [measurement]
---

# Frame envelope wire format (TFFE v1)

> The binary header prepended to every video frame so a Perfetto trace can show all five
> latency hops. Read this before changing the frame binary layout or the relay's binary
> forwarding path.

Each frame carries agent-capture and relay-forward timestamps in a fixed 22-byte header
ahead of the payload, so a trace covers `agent-capture → relay → ws-recv → decode → paint`
instead of only the three browser-side hops.

## Layout

```
Offset  Size  Type       Field
0       4     bytes      magic = [0x54, 0x46, 0x46, 0x45]  ('TFFE')
4       1     uint8      version = 1
5       1     uint8      flags (reserved, 0)
6       8     uint64 BE  capturedAt — agent capture time (ms since epoch)
14      8     uint64 BE  relayedAt  — relay forward time (ms since epoch, patched in place)
22      ...   bytes      payload (JPEG or H.264)
```

The agent writes the header and `capturedAt` before sending; the relay patches `relayedAt`
in place at offset 14 as the frame passes through.

## Rules that keep it safe

- **Backward compatible by magic detection.** A frame without the `TFFE` magic is a plain
  payload; the relay forwards it untouched and the browser parser returns null. Old clients
  and new clients interoperate.
- **The header is added in the TypeScript layer, not the Swift capture binary**, so the
  format can change without recompiling native code.
- **`Date.now()` precision is deliberate.** Network jitter is in milliseconds, so
  sub-millisecond clocks add nothing. The format also assumes a single self-hosted Mac; it
  does not correct for relay↔browser clock skew.
- **In-place `relayedAt` patching assumes the received Buffer is not a shared/reused
  buffer.** If the `ws` library ever reuses the receive buffer synchronously, the relay
  must copy before patching.
- Reading `capturedAt`/`relayedAt` uses `DataView.getBigUint64`; `Number()` is lossless for
  millisecond timestamps (below 2^53).
