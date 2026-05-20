# @tapflowio/ios-agent

iOS simulator agent for [tapflow](https://github.com/jo-duchan/tapflow).

Controls iOS simulators via `xcrun simctl`, streams frames using SimulatorKit IOSurface callbacks, and injects touch/keyboard input via SimDeviceLegacyHIDClient — no WebDriverAgent required.

## Requirements

- macOS only
- Node.js ≥ 20
- Xcode Command Line Tools (`xcrun`)

## Usage

Typically started via the `tapflow` CLI:

```sh
tapflow start
```

Or programmatically:

```ts
import { IOSAgent } from '@tapflowio/ios-agent'

const agent = new IOSAgent()
await agent.connect('ws://your-relay:3000')
```

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.
