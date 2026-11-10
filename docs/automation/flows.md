---
title: Flow Reference
description: "The YAML flow format that tapflow flow run replays deterministically with no LLM calls: file structure, step types, selectors, running in CI, and the link for watching a run."
---

# Flow Reference

::: warning Experimental
tapflow's **AI agents** (the MCP server) and **Automation** (the flow runner) are experimental. The manual QA dashboard is the most mature part of tapflow; these two are still maturing. Expect rough edges, especially in selector matching and in timing right after an app launches.
:::

A flow is a UI test scenario written in YAML, replayed deterministically by `tapflow flow run` with no LLM calls. The same flow always runs in the same order from the same input, so it is idempotent — and it costs nothing in API calls in CI.

::: info Three ways to use tapflow
There are three ways to use tapflow, all on the same devices and sessions: **Manual QA** in the browser dashboard, where your team tests by hand; **AI agents**, which drive a device through MCP; and **Automation**, the flow runner covered here, whose main stage is CI/CD.

Flows are not a language you hand-write from scratch — they are an artifact a coding agent generates or a recording produces. To author them with an agent, see [MCP in CI/CD](/automation/mcp-ci).
:::

## Flow file structure

A flow is made of these top-level keys.

```yaml
name: login-smoke
appId: com.example.app
steps:
  - clearState
  - launchApp
  - assertVisible: "Sign in"
  - tapOn: { id: "com.example.app:id/email" }
  - inputText: "user@example.com"
  - pressKey: Enter
  - tapOn: "Sign in"
  - assertVisible: { label: "Orders", timeout: 15 }
```

| Key | Required | Description |
|-----|----------|-------------|
| `name` | No | Name shown in reports. Defaults to the file name. |
| `appId` | Conditional | Bundle id of the app under test. Required when `clearState` is used without an argument. With `--build`, it is compared with that build's bundle id ([Choosing flows](#choosing-flows)). |
| `tags` | No | A list of tags. Use them to pick flows with `--include-tags` and `--exclude-tags`. A tag cannot contain a comma. |
| `viewport` | No | The screen size the flow's points were made on, `{ width, height }` (iOS in points, Android in pixels). A device of another size does not run the point steps. See [Tapping a point](#tapping-a-point). |
| `steps` | Yes | The list of steps, run top to bottom. |

Coordinates are normalized 0–1 everywhere. Selectors point at screen elements directly, so you will rarely write pixel coordinates into a flow. Coordinates are measured on the screen as the app draws it. When the app is drawn in landscape, `[0.5, 0.1]` is the top center of the landscape screen.

## Steps

The vocabulary is deliberately small. These steps cover most scenarios.

| Step | Form | Behavior |
|------|------|----------|
| `clearState` | keyword or `clearState: <bundleId>` | Resets the app data. The keyword form uses the top-level `appId`. |
| `launchApp` | keyword or `launchApp: { arguments, env }` | Launches the build under test and waits for its screen to settle: the role, label and id of every UI tree element unchanged for a second, so a splash screen is not taken for the first screen. A screen with no UI tree elements, such as a game, moves on after that second too. A screen whose labels keep changing moves on 3 seconds after it was first read, and one that cannot be read at all after the default per-selector wait. The wait never fails the step. A splash that stays unchanged for longer than a second can still be taken for the first screen. To pass launch arguments, see [Launch arguments](#launch-arguments). |
| `tapOn` | selector or `[x, y]` | Taps the matched element where the device says a touch reaches it ([Where a touch lands](#where-a-touch-lands)), or a point. See [Tapping a point](#tapping-a-point). With an `expect` beside it, checks that the screen changes as it says after the tap ([Expected effects](#expected-effects)). |
| `inputText` | string, `{ text, replace: true }` or `{ secret: NAME }` | Types text into the focused input field. With `replace: true` the text replaces what the field holds instead of being added to it; on Android that needs Android 13 or later, and an older device fails the step. For a value that must not be written in the flow file, such as a password, see [Secrets](#secrets). |
| `pressKey` | key name or `{ code, modifiers }` | Presses a keyboard key (`Enter`, `Backspace`, `Escape`, …). For a key combination, list the keys to hold from `shift`, `ctrl`, `alt` and `meta`, as in `{ code: ArrowLeft, modifiers: [shift] }`. On Android the only letter keys that take `ctrl` or `meta` are A, C, V and X (A from Android 13), and `alt` does not apply to letter keys. |
| `imeAction` | keyword | Presses the focused field's own action, the key at the corner of the on-screen keyboard: Done, Next, Search or Go. Use it rather than `pressKey: Enter` when the app acts on that key, since an Android app that checks which action it received ignores Enter. Android 11 or later. |
| `swipe` | `{ from, to, durationMs? }` | Swipes between two points. Coordinates are 0–1. `durationMs` is milliseconds as a number, default 300, max 2147483647. Fractional values (e.g. 250.5) are accepted. |
| `scroll` | keyword, `scroll: <direction>` or `{ direction, until }` | Scrolls the screen. The bare keyword scrolls down. With `until`, it scrolls until that element is on screen. See [Scrolling to an element](#scrolling-to-an-element). |
| `openUrl` | URL string | Opens a deep link or URL. |
| `assertVisible` | selector | Waits until the element appears; fails if it does not. |
| `assertNotVisible` | selector | Waits until the element disappears; fails if it does not. |
| `pressButton` | button name | Presses a hardware button. See [Hardware buttons](#hardware-buttons). |
| `longPressOn` | selector, `[x, y]` or `{ on, durationMs? }` | Presses the matched element where a touch reaches it, or a point, and holds it, 1000 ms by default, at most 60000. To change the time, put the selector or point under `on`. Takes an `expect` as `tapOn` does. |
| `pinch` | `{ on, scale, durationMs? }` | Two fingers about the center of an element or a point. See [Pinch](#pinch). |
| `setOrientation` | `portrait` or `landscape` | Turns the device upright or sideways. See [Orientation and posture](#orientation-and-posture). |
| `setPosture` | `folded` or `unfolded` | Folds or unfolds a foldable device. See [Orientation and posture](#orientation-and-posture). |

There is no fixed `sleep` step. Waiting is always condition-based. To wait for a transition, give `assertVisible` a `timeout`.

### Selectors

`tapOn`, `assertVisible`, `assertNotVisible`, `longPressOn` and the `on` of `pinch` target an element with a selector, which takes three forms.

```yaml
# a single string — resolved in the order below
- tapOn: "Sign in"

# explicit identifier
- tapOn: { id: "com.example.app:id/login" }

# explicit label + wait time (seconds)
- tapOn: { label: "Sign in", timeout: 20 }

# narrow a shared label by element kind
- tapOn: { label: "New Orders", role: button }

# a label-less row: pick the Nth of its kind (0-based)
- tapOn: { role: cell, index: 2 }
```

A bare-string selector resolves in the order **exact identifier → exact label → partial label → exact placeholder**. Once a stage matches, later stages are not tried.

A placeholder is the hint text an empty input field shows. An input field with neither a label nor an identifier can be found by its placeholder. Because the placeholder is the last stage, an element whose label is the same text matches first. A placeholder never matches in part. On iOS the field can still be found by its placeholder after a value is typed into it. Android's UI tree carries no placeholder, so on Android this stage never matches. A `label:` selector looks at labels only.

If a `tapOn` selector matches more than one element, it fails immediately and lists the candidates. It never picks the first one implicitly, so an ambiguous selector fails visibly instead of quietly tapping the wrong place. `assertVisible` checks presence only, so it passes when at least one element matches.

When a `tapOn` fails because its selector matched nothing or more than one element, the runner prints up to three lines to try instead, taken from the screen at the moment it failed: `try: tapOn: "Sign in"`. Each one is a selector checked to tap exactly that one element on that screen, and it is kept in the [run record](#run-records) too. An input field is suggested by its `id` or its placeholder, never its label, so what was typed into it is not shown. An image is suggested only when its name matches the selector's, ignoring case, spacing and punctuation, because an image's name is usually an asset name rather than text on the screen. A failed `assertVisible` gets no suggestions: the expected text being missing can mean the app changed, and swapping in similar text would hide the regression.

To resolve an ambiguous match, add a disambiguator to the object form:

- `role` — narrow by element kind (`button`, `text`, `cell`, `input`, …), e.g. when a button and its inner text share a label.
- `index` — 0-based; pick the Nth remaining match. Useful for label-less, id-less rows where `role` alone still matches several.

The object form needs at least one of `id`, `label`, or `role`; `role`/`index` refine that set.

`timeout` is in seconds and defaults to 10 (max 2147483.647, about 24.8 days). You can set it per selector. Values that round to 0ms (e.g. 0.0004s) are rejected.

### Scrolling to an element {#scrolling-to-an-element}

How far one swipe scrolls differs from run to run: a list travels further or less depending on the speed at release and on the platform. When you need a row further down a list, name the element to reach with `until` instead of counting swipes.

```yaml
- scroll: { until: "Row 16" }
- scroll: { direction: up, until: { id: "header" } }
- tapOn: "Row 16"
```

- The screen is read first, and nothing is scrolled when the element is already in view.
- An element cut by the edge the list scrolls in from has not arrived yet: the bottom edge when you scroll down. A tap on its center can land on a tab bar drawn over it, so the step scrolls once more.
- An element inside the screen has not arrived either while the device says a touch at its center would not reach it, as with a row that slid under a tab bar and still reads whole in the UI tree. The step scrolls once more. A device that cannot judge leaves it to the screen's edges, as before.
- The wait is the `until` selector's `timeout`. Without one it is 30 seconds or the run's default wait (`--timeout`), whichever is longer. An emulator takes over 2 seconds to read the screen once, so the default selector wait would allow only a few scrolls.
- When the screen is unchanged for two scrolls in a row, the step takes it as the end of the list. It passes if the element is on screen there, even cut, and fails if it is not. A cut element that stays put for two scrolls, such as a button fixed to the bottom, also counts as arrived.
- A screen that scrolls one long text filling the screen, with nothing else moving, reads as unchanged and can be taken for the end of the list. A list that loads more items at its end must show them within two reads of the screen (2–5 seconds).

### Holding an element {#holding-an-element}

A bare `longPressOn` holds for 1000 ms, which is past the point where both platforms read a press as a long press. To hold for a different time, put the selector under `on`:

```yaml
- longPressOn: "Message"
- longPressOn: { on: "Message", durationMs: 2500 }
- longPressOn: { on: { id: "row-3" }, durationMs: 2500 }
```

On an Android device streaming over the adb fallback, a hold needs android-agent from the same release. An older agent delivers it as a tap and still reports success, so follow `longPressOn` with an assertion on what the hold opens.

`durationMs` goes beside the selector, never inside it. `{ label: "Message", durationMs: 2500 }` is refused, because turning a bare string into `label:` would also change how it matches: `label:` does not look at identifiers.

### Tapping a point {#tapping-a-point}

A place the UI tree has no name for (a game, a map, a canvas) cannot be reached with a selector. Give a point instead. Points are 0–1 on the screen as the app draws it, so on a landscape screen they are landscape.

```yaml
- tapOn: [0.42, 0.61]
- longPressOn: { on: [0.5, 0.5], durationMs: 1500 }
```

A point is the last resort. It does not wait for anything to appear, and a different screen size or layout puts it somewhere else. Use a selector wherever one reaches the element, and put an `assertVisible` before a point tap to check the screen is the one you expect.

Nothing can check what is under a point, so its step is recorded as `delivered`. With a top-level `viewport`, a device of another size is refused before the first step as an environment failure (exit code `2`). A device held either way counts as the same size. Flow Capture writes the size of the device Verify ran on into a flow that has point steps.

```yaml
viewport: { width: 402, height: 874 }
steps:
  - launchApp
  - tapOn: [0.42, 0.61]
```

### Where a touch lands {#where-a-touch-lands}

`tapOn`, `longPressOn` and a `pinch` on a selector do not press the center of the element's frame. They first ask the device where on the element a touch reaches it, and press there. When a tab bar, a floating button or a translucent scrim covers part of the element, the visible part is pressed. The same point has to come back twice in a row, so a list still settling from a scroll is waited for.

- An element wholly covered by another that takes touches is checked again until the selector's `timeout`, then the step fails with `is covered by …: a touch on it would land on that instead`.
- An element off the screen, or one that keeps moving, fails the step saying so.
- iOS uses XCUITest's judgement and Android the drawing order of the accessibility tree. On Android, an element covered only by elements not marked as taking touches cannot be judged.
- When the device cannot judge (older agents and relays included), the center is pressed as before and the step is recorded `unchecked`. `tapflow flow run` says so even under a flow that passed, as `! 1 touch not checked to land on its element (…)`, and [Flow Runs](/automation/runs) and Verify show the same.

An overlay with no accessibility information is invisible to this judgement on both platforms, such as a translucent scrim built from a UIView that is not an accessibility element. A tap it takes still counts as reaching the element. [Expected effects](#expected-effects) below catch such a tap. Give an overlay that blocks touches an accessibility identifier, and the device can then judge what it covers.

### Expected effects {#expected-effects}

A tap that landed elsewhere, or one a hidden overlay took, was sent but changed nothing. With `expect` beside `tapOn` or `longPressOn`, the run checks that the screen changes as it says after the touch.

```yaml
- tapOn: "Save"
  expect:
    appear:
      - { text: "Saved", role: text }
    gone:
      - { id: "save.button" }
- tapOn: { id: "wifi" }
  expect:
    appear: [{ id: "wifi", checked: true }]
```

- Every element under `appear` must be shown, and none under `gone` may remain. The screen is read again for the default selector wait (10 seconds), then the step fails as the product's, naming what was missing.
- A screen that already looked that way before the touch fails the step, because nothing shows the touch did anything. That keeps data left by an earlier run from passing it.
- An element is named by `id` or `text`, narrowed by `role`, `checked` (a switch or checkbox that is on) and `selected`. `text` must equal the label exactly.
- Flow Capture writes `expect` from what both Match's replay and Verify's run saw a touch do. Seen twice minutes apart, a number that changes by itself usually reads differently. A touch Match did not watch keeps what Verify saw: a tap the dialog added, or any tap after a Match that was stopped partway.
- It leaves out input fields, password fields, keyboard keys and labels holding a secret's value, and text that changes by itself: a time, a date, a number of four digits or more, a time such as "5 min ago" or "250ms", a label that is only a number and has no identifier, a count such as "41 items" whose number the touch moved, and text whose number changed in the 1.5 seconds after the screen settled. It picks elements with an identifier and near the top of the screen first, up to 4 of each.
- A step without `expect` is not checked. A flow you write by hand can go on checking results with `assertVisible`.
- A flow with `expect` cannot be read by a `tapflow` from before this feature. Update the `tapflow` your CI runs it with as well.

### Secrets {#secrets}

Type a value that must not be written in the flow file, such as a password, by name:

```yaml
- tapOn: { id: "password" }
- inputText: { secret: PASSWORD }
```

Pass the value with `--secret` when you run `tapflow flow run`. It is read from the environment variable of the same name.

```sh
PASSWORD=hunter2 tapflow flow run .tapflow/flows/login.yaml --secret PASSWORD
```

- Only the names given with `--secret` are read. The environment holds other secrets too, such as the relay token, so changing a flow file alone cannot type one of them into the app.
- The value appears in no run record, JUnit report or step name. The step is named `inputText(secret PASSWORD)`.
- A flow that uses a secret the run was not given stops the run with an environment error before a device is chosen. So does a `--secret` whose environment variable is not set or is empty, since CI passes a secret it does not have as an empty value.
- `run_flow` over MCP is given no secrets, so it does not run a flow with this step.

### Pinch {#pinch}

`pinch` puts two fingers on either side of a center and changes the space between them by `scale`. A `scale` above 1 spreads them apart, which zooms in. Below 1 brings them together, which zooms out. It takes any value from 0.1 to 10 except 1.

```yaml
- pinch: { on: "Map", scale: 2 }               # zoom in on the element's center
- pinch: { on: [0.5, 0.4], scale: 0.5 }        # zoom out about a point (0–1)
- pinch: { on: "Photo", scale: 3, durationMs: 800 }
```

`on` is a selector or a point. A point is for a screen with nothing in the UI tree to name, such as a map or a canvas. The gesture takes 500 ms by default, at most 60000.

The `scale` is kept exactly and the space between the fingers is what adapts. The fingers spread along whichever axis has more room, and they stay inside the screen. When the center is so close to a corner that even the narrowest spacing does not fit, the step fails and says so.

An Android device streaming over the adb fallback, without a gRPC or scrcpy pointer channel, cannot pinch. The step then fails as an environment failure, not as a failure of the app: the run exits with code 2 unless another flow failed in the app, which makes it 1.

### Hardware buttons {#hardware-buttons}

`pressButton` takes a button name.

| Name | iOS | Android |
|------|-----|---------|
| `home` | Yes | Yes |
| `lock`, `power` | When the device has a power button | Yes (the power key) |
| `volume_up`, `volume_down` | When the device has volume buttons | Yes |
| `back`, `recent_apps` | No | Yes |

On iOS, any other button the device's frame declares can be pressed by its name as well, such as `action`.

A flow that presses a button the device lacks fails before its first step, instead of running on to fail one step later at an assertion that would not explain why. When `flow run` knows the platform before it picks a device, from the build in `--build` or from `--platform` with `--parallel`, the flow fails without a device being booted for it, and the other flows still run. A button that depends on the device, such as `lock` on iOS, is checked against the device before the first step. Either way the failure is an environment failure, since the app was never tested: the run exits with code 2 unless another flow failed in the app, which makes it 1. On iOS, use the app's own back control with `tapOn` instead of `back`, or tag the flow and run it only where the button exists.

### Orientation and posture {#orientation-and-posture}

`setOrientation` turns the device to `portrait` or `landscape`. `setPosture` folds a foldable device (`folded`) or opens it (`unfolded`).

```yaml
- setOrientation: landscape
- assertVisible: "Landscape layout"
- setOrientation: portrait
- setPosture: folded
- setPosture: unfolded
```

Both steps wait until the device reports that it is in the requested state. When it already is, they send nothing. If the report does not arrive within the default per-selector wait (`--timeout`, 10 seconds by default), the step ends as an environment failure.

With `landscape`, the device turns to whichever of its two sideways directions it picks. An app locked to portrait is still drawn upright after the device turns, so check the screen after a turn with `assertVisible`. Selectors and coordinates after a turn are measured on the screen as the app draws it. A step that takes only coordinates (`swipe`, `scroll`, `pinch` on a point) reads the app's orientation from the last UI tree it read. If someone turns the device from the dashboard while a flow runs, those steps are placed by the previous orientation until the next tree read.

A foldable on Android 15 or later puts up a "Swipe up to continue" lock screen when it folds. The agent takes it down, so the steps after a fold see the app. A device that was locked before the fold, or one with a PIN, pattern or password, is left locked, so do not set a secure lock on a device you run flows on.

A step the device cannot do ends as an environment failure. `setPosture` fails this way on a device that does not fold. `setOrientation` fails this way on a device that does not report which way it is held: an iOS device with more than one panel, or an Android device streaming over scrcpy without gRPC. With `--parallel`, the worker does not leave the device over this failure, because other flows still run fine on it.

### Resetting state

`clearState` wipes the app data so every run starts from the same state. It uses `pm clear` on Android and empties the app data container on iOS. The installed binary survives either way, so you can follow `clearState` with `launchApp`.

`tapflow flow run` also resets the device before the flows start, so a run does not begin from an earlier run's data, keychain or permissions. `clearState` is still how a flow resets its app between its own steps. What the run resets is listed under [`tapflow flow run`](/reference/cli#tapflow-flow-run).

If the app is already running, `launchApp` does not restart it: it brings the app forward on whatever screen it was last on. A `launchApp` with [launch arguments](#launch-arguments) is the exception. A flow can then start from a screen an earlier run or a manual test left behind, so a flow that must start from the app's first screen puts `clearState` before `launchApp`. `clearState` stops the app before wiping its data.

```yaml
# uses the top-level appId
- clearState

# names a different bundle
- clearState: com.other.app
```

### Launch arguments {#launch-arguments}

`launchApp` can pass arguments to the app it launches. You can turn on a debug option that only a launch argument enables, such as Firebase DebugView, or change an app flag such as a staging server address, without a new build.

```yaml
- launchApp:
    arguments:
      FIRDebugEnabled: true
      apiHost: staging.example.com
      AppleLanguages: [en]
    env:
      API_TOKEN: secret-value
```

| Key | Values | iOS | Android |
|-----|--------|-----|---------|
| `arguments` | string, whole number, `true`/`false`, list of strings | Passed after the bundle id as `-key value`. The app reads them with `UserDefaults` and `ProcessInfo.arguments` | Passed as intent extras. The app has to read them with `getIntent().getExtras()` |
| `env` | string | Set in the app process's environment | Not supported. The step fails if you pass it |

- With arguments or env, the app is stopped and started again even if it is already running, because a running app does not read its launch arguments again.
- On Android a value's type decides the extra's type: a whole number is an int (a long when it does not fit), `true`/`false` a boolean, a list a string array. Quote a number the app reads as a string, as in `port: "8080"`. On iOS every value arrives as a string.
- Fractions are refused, because older Android images have no double extra. Quote a fraction to pass it as a string.
- Write a key without the `-` that iOS adds. A key such as `-FIRDebugEnabled` is refused when the flow loads.
- Put secrets in `env`. Run records and failure messages show argument values as they are, and env values as `***`.
- Environment names tapflow depends on are refused: names starting with `DYLD_`, `TAPFLOW_` or `SIMULATOR_`, `HOME`, `TMPDIR` and a few more.
- Third-party SDKs turn on their debug options differently on each platform. Firebase DebugView, for example, turns on with `FIRDebugEnabled: true` on iOS, but on Android no intent extra turns it on: run `adb shell setprop debug.firebase.analytics.app <package>` on the device instead.
- The relay and the agent on the device's Mac both need a version that supports launch arguments. If either is older, the step fails rather than launching without them.
- The relay can add [launch defaults](/reference/configuration#launch-defaults) for the app from `tapflow.config.json`. When the step and the defaults set the same key, the step's value is used. In the run record, the keys of the defaults a launch applied follow the step's own options, without their values: `launchApp(apiHost="staging.example.com"; config: FIRDebugEnabled, env API_TOKEN)`.

## Running flows

```sh
tapflow flow run .tapflow/flows/login-smoke.yaml
```

You can pass several files at once.

```sh
tapflow flow run .tapflow/flows/login.yaml .tapflow/flows/checkout.yaml
```

| Option | Description |
|--------|-------------|
| `--relay <url>` | Relay URL (default `ws://localhost:4000`) |
| `--token <token>` | Personal access token (PAT) for a remote relay (or the `TAPFLOW_TOKEN` env var, or the [token file](/automation/mcp-server#token-file)). Use an API-type token from the dashboard (`view, builds:write`) |
| `--device <name>` | Target device by name. Boots it when shut down. |
| `--session <id>` | Session id of the target device. Use it when several devices share a name and `--device` cannot pick one. |
| `--build <id>` | Build under test. Installed before the run; the `launchApp` step launches it. |
| `--no-install` | Skip installing the `--build` build before the run. Use it to re-run against a build that is already installed. |
| `--junit <path>` | Write a JUnit XML report to this path. |
| `--artifacts <dir>` | Failure-screenshot directory (default `.tapflow/artifacts`) |
| `--timeout <seconds>` | Default per-selector wait (default 10, max 2147483.647) |
| `--no-record` | Do not record this run on the relay. |
| `--include-tags <tags>` | Run only flows tagged with at least one of these (comma-separated). |
| `--exclude-tags <tags>` | Skip flows tagged with any of these (comma-separated). Wins over `--include-tags`. |

The `launchApp` step names no build and launches the one passed via `--build`. That keeps the build id out of the flow file, so the same flow runs against a fresh build on every CI run.

When the run starts, the runner prints a dashboard link on a `watch this run:` line. Open it to watch, live, the flow driving the device; the watch ends when the run does. In CI the line is not printed (detected from the `CI` environment variable, Jenkins's `JENKINS_URL` or Azure Pipelines' `TF_BUILD`), because the link shows the relay's address and would stay in a public repository's log. How the address is chosen, and who can watch, are the same as for the [MCP server](/automation/mcp-server#watch-the-device), with the `--relay` address in place of `TAPFLOW_RELAY_URL`.

### Choosing flows {#choosing-flows}

A flow that does not fit this run is skipped rather than run. There are two cases.

- **A flow for another app**: with `--build`, each flow's `appId` is compared with that build's bundle id. When they differ, the runner prints both ids, as in `– login (skipped: flow is for com.example.app, build 42 is com.example.app.debug)`, and skips the flow. You can pass a directory that mixes several apps' flows, and only the ones for the build run. A flow with no `appId` runs against any build.
- **A flow the tags filter out**: `--include-tags smoke,login` runs only flows that carry at least one of the two. `--exclude-tags flaky` skips flows that carry it, and when the two overlap, `--exclude-tags` wins.

A skipped flow does not count as a failure. The last line counts it separately, as in `1/1 flows passed, 1 skipped`. When no flow runs at all, the run stops with exit code `2` before choosing a device, so a run that tested nothing cannot read as a pass. A build id the relay does not have stops the run the same way.

Comparing `appId` needs a token that can read the build: an API-type token (`view, builds:write`). With no token, or a `view` token, the runner prints an `app check skipped` line and runs every flow whatever its `appId`. If you run a flow against a build whose bundle id carries a suffix, such as a debug build (`com.example.app.debug`), set `appId` to that build's id or remove it.

### Run records {#run-records}

With a token, the runner records the run on the relay: each flow's pass, fail or skip, why a flow was skipped, its steps, a screenshot of the screen each flow failed on or ended on, the device it ran on and what it was reset of, and the build passed with `--build`. In CI it also records the provider, branch, commit and a link to the CI run. When the relay created the record, the runner prints its id on a `recorded as run` line at the end of the run, followed outside CI by a link to the run's dashboard page. The records are on the dashboard's [Flow Runs](/automation/runs) page.

- Recording never changes the result or the exit code. If the relay does not answer or refuses the record, the runner prints one warning line and records nothing more for that run. A screenshot the relay cannot take (for example, one over 5 MB) gets its own warning, and the rest of the run is still recorded. At the end of a run it waits at most 10 seconds for the record to finish sending. Capturing a passed flow's last screen takes one screenshot before the next flow starts, at most 5 seconds.
- While recording, the runner also sends each flow's video. It cuts the device stream it already receives, so a flow never waits on the video being sent. On iOS it asks the agent for an H.264 stream for this, and when the agent is set to send JPEG (`TAPFLOW_IOS_CODEC=jpeg`) no video is kept. If video cannot be sent, the runner prints one warning line and the record carries on. At the end of a run the record is sent first, and video gets what is left of the 10 seconds. The relay keeps a passed flow's video for 3 days by default, and when all videos together pass 20 GB it removes passed flows' videos first, oldest first.
- Recording needs a token with the `builds:write` scope whose owner is not a Viewer. An API-type token works.
- A run without a token against a relay on the same Mac is not recorded, and one line says so.
- A run's record is deleted with its build; a record of a run with no build is deleted after 7 days.

### Exit codes

The exit codes are a contract so CI can tell what happened.

| Code | Meaning |
|------|---------|
| `0` | All flows passed |
| `1` | At least one product failure, including a run with both product and environment failures |
| `2` | Environment/config error before execution, or every failed flow was environmental |
| `130` | Cancelled by `SIGINT` (Ctrl+C, or a cancelled GitHub Actions job) |
| `143` | Cancelled by `SIGTERM` (what `kill` sends by default) |

Distinguishing `1` from `2` matters: a product failure (`1`) and an infrastructure problem (`2`) should be handled differently on a CI dashboard. A run with both kinds stays at `1` so an infrastructure blip cannot hide a regression.

A run cancelled while its flows are running leaves its session and, when it is being recorded, marks the record cancelled before it exits. A second signal exits at once.

A failed flow leaves a screenshot from the point of failure in the artifacts directory, and with `--junit` each flow is recorded as one `testcase`. A skipped flow is a `testcase` with `<skipped>`.

## File location convention

Keep flow files in your app repository under `.tapflow/flows/`. The runner accepts any path, so this is not enforced, but the CI examples and docs default to it.

```text
your-app/
├── .tapflow/
│   └── flows/
│       ├── login-smoke.yaml
│       └── checkout.yaml
└── ...
```

A JSON Schema for editor autocomplete ships with the `@tapflowio/flow-runner` package at `schema/tapflow-flow.schema.json`.

## Running in CI

With a relay and agent always on a self-hosted Mac runner, a CI job only has to replay the flows. No LLM is involved on the replay path, so there is no API cost.

```yaml
name: Flow smoke test

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: [self-hosted, macos]

    steps:
      - uses: actions/checkout@v4

      - name: Run flows
        env:
          TAPFLOW_RELAY_URL: ${{ secrets.TAPFLOW_RELAY_URL }}
          TAPFLOW_TOKEN: ${{ secrets.TAPFLOW_TOKEN }}
        run: |
          tapflow flow run .tapflow/flows/*.yaml \
            --relay "$TAPFLOW_RELAY_URL" \
            --device "iPhone 16 Pro" \
            --build "$BUILD_ID" \
            --junit report.xml

      - name: Publish report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: flow-results
          path: |
            report.xml
            .tapflow/artifacts/
```

The exit-code contract makes the job fail when a step fails (`1` or `2`). `if: always()` collects the failure screenshots and the JUnit report even on a failing run.

## Relationship to run_flow

The same flow engine runs through the MCP `run_flow` tool. A coding agent authors a scenario once while exploring the app, then replays that flow deterministically afterward. Exploratory work goes through the individual MCP tools; verified scenarios replay through `run_flow` — a hybrid of the two.

Authoring by an agent and replaying with a deterministic runner is covered in more depth in [MCP in CI/CD](/automation/mcp-ci).
