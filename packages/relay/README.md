# @tapflowio/relay

WebSocket relay server for [tapflow](https://github.com/jo-duchan/tapflow).

Handles NAT traversal between browser clients and device agents, session routing, JWT authentication, and serves the bundled dashboard as a static SPA.

## Requirements

- Node.js ≥ 20

## Usage

Typically started via the `tapflow` CLI:

```sh
tapflow start
```

Or standalone:

```ts
import { RelayServer } from '@tapflowio/relay'

const server = new RelayServer({ port: 3000 })
await server.start()
```

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.
