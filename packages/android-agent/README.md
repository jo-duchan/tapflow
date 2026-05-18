# @tapflow/android-agent

Android emulator agent for [tapflow](https://github.com/jo-duchan/tapflow).

Controls Android emulators via ADB and streams H.264 video using [scrcpy](https://github.com/Genymobile/scrcpy).

## Requirements

- Node.js ≥ 20
- Android SDK with `adb` (`$ANDROID_HOME` or `$ADB_PATH` must be set)
- AVD with `google_apis/arm64-v8a` system image (android-34 recommended)

## Usage

Typically started via the `tapflow` CLI:

```sh
tapflow start
```

Or programmatically:

```ts
import { AndroidAgent } from '@tapflow/android-agent'

const agent = new AndroidAgent()
await agent.connect('ws://your-relay:3000')
```

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.

> Bundles [scrcpy-server](https://github.com/Genymobile/scrcpy) (Apache-2.0). See [NOTICE](../../NOTICE) for full attribution.
