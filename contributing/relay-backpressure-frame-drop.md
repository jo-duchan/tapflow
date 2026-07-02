---
type: rationale
topics: [relay, streaming, backpressure]
status: stable
related: [relay-heartbeat]
---

# Why the relay drops frames on WebSocket backpressure

> Read this before sending a binary frame without checking `bufferedAmount`. A slow
> browser can otherwise grow the relay's send buffer without bound.

## The problem

On the Agent → Relay → Browser path, sending a binary frame without checking
`ws.bufferedAmount` means a slow browser lets the relay's outbound buffer grow without
limit, which can reach OOM or degrade every session on that relay.

## The decision

Before each send, check the buffer threshold and, if it is over, **drop that frame
silently**. This caps memory at a bound and is the standard pattern for MJPEG/H.264
streaming: a dropped frame is cheaper than an unbounded queue, and the next frame
supersedes it anyway.

The guard is a shared helper: it sends only when `readyState === OPEN` and
`bufferedAmount < threshold`, and calls an `onDrop()` callback so the caller controls
logging and counting. The threshold is injected by the caller (DIP) rather than hardcoded.

This is distinct from the relay's keyframe drop under LAN backpressure, which exists to
remove tearing; this one exists to bound memory.
