---
type: rules
topics: [agent-core, interface, design]
status: living
---

# agent-core — AGENTS.md

> Common rules: [AGENTS.md](../../AGENTS.md) | Full index: [INDEX.md](../../INDEX.md)

---

## WHAT

Defines the `DeviceAgent` interface and `AgentRegistry`.
The sole contract that platform implementations (ios-agent, android-agent) depend on.

## HOW

- The interface contains only platform-neutral methods: `listDevices`, `boot`, `shutdown`, `installApp`, `launchApp`, `screenshot`, `stream`, `touchStart`, `touchMove`, `touchEnd`.
- `AgentRegistry`: platforms self-register via `register(platform, AgentClass, opts?)` (with a `connect` hook and optional `canRun` gate); the CLI drives them through `available()` / `connect(platform, relayUrl, opts)`. `connect`'s `AgentConnectOpts` carries `deviceFilter` and an optional `token` (opaque credential the agent forwards to a remote relay as `Authorization: Bearer`).
- Interface changes must pass all implementation package tests before merging.

## HOW NOT

- Do not put platform-specific types (xcrun responses, ADB output, etc.) in this package.
- Do not add platform-specific methods to the `DeviceAgent` interface.
- Runtime dependencies are allowed only in shared implementation utils (`src/utils/`). Interface and registry code must have zero dependencies.

## Directory Structure

- `src/` — `DeviceAgent` interface, `AgentRegistry`, shared types, `createLogger` (leveled console logger)
- `src/utils/` — shared implementation utils for ios-agent, android-agent, and the relay. Currently: `createResourceSampler` (CPU & memory sampling, `resources.ts`); and in `stream.ts`: `registerStreamWs` (stream:register handshake helper), `disableNagle` (TCP_NODELAY — kills the ~40ms Nagle/delayed-ACK stall on small LAN writes), `sendBinaryWithBackpressure` (drop-to-latest), and `createKeyframeAwareSender` (drop-to-keyframe — preserves the H.264 reference chain under backpressure). Not exposed through the `DeviceAgent` interface.
