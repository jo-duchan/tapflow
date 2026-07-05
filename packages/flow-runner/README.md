# @tapflowio/flow-runner

Deterministic YAML flow runner for [tapflow](https://github.com/jo-duchan/tapflow) — replay UI test flows against iOS simulators and Android emulators with **zero LLM calls**.

Flows are authored once (by an LLM agent through `@tapflowio/mcp-server`, or by hand) and replayed deterministically: same input, same execution, no API cost in CI.

## Usage

Most users run flows through the tapflow CLI:

```sh
tapflow flow run .tapflow/flows/*.yaml --build 42 --junit report.xml
```

Exit codes: `0` all flows passed · `1` a flow failed · `2` environment/config error.

## Flow YAML

```yaml
name: login-smoke
appId: com.example.app
steps:
  - clearState              # reset app data (pm clear / data-container wipe)
  - launchApp               # launches the build under test (--build)
  - assertVisible: "Sign in"
  - tapOn: { id: "com.example.app:id/email" }
  - inputText: "user@example.com"
  - pressKey: Enter
  - tapOn: "Sign in"
  - assertVisible: { label: "Orders", timeout: 15 }
```

- 10-step vocabulary: `clearState / launchApp / tapOn / inputText / pressKey / swipe / scroll / openUrl / assertVisible / assertNotVisible`. No sleep step — waiting is always condition-based.
- Selectors: a bare string matches exact identifier → exact label → partial label. Ambiguous `tapOn` matches fail loudly instead of picking one.
- A JSON Schema for editor autocomplete ships at `schema/tapflow-flow.schema.json`.

## Library API

```ts
import { parseFlow, runFlow, RelayClient, RelayDriver, toJUnitXml } from '@tapflowio/flow-runner'
```

The engine drives a transport-agnostic `FlowDriver` interface; `RelayDriver` implements it against a tapflow relay (WebSocket + REST).

## License

[MIT](LICENSE) — part of the [tapflow](https://github.com/jo-duchan/tapflow) project.
