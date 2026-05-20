# @tapflowio/agent-core

Shared interface and utilities for [tapflow](https://github.com/jo-duchan/tapflow) agents.

## What's inside

- `DeviceAgent` interface — implemented by `@tapflowio/ios-agent` and `@tapflowio/android-agent`
- `AgentRegistry` — maps platform name to agent class
- Shared types: `Device`, `DeviceStatus`, `AgentResources`, `AndroidButton`
- Internal utilities: `createResourceSampler`, `registerStreamWs` (used by agent implementations)

## Usage

This package is consumed by agent implementations and the tapflow CLI. You don't need to install it directly.

```ts
import type { DeviceAgent, Device } from '@tapflowio/agent-core'
import { AgentRegistry } from '@tapflowio/agent-core'
```

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.
