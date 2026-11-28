---
title: AI Agent Flow Capture
description: Save a path a coding agent checked on a device over MCP as a flow YAML. The MCP server records the agent's taps and typing, and capture_flow resets the device as CI does, replays the flow, and returns it only if it passes.
---

# AI Agent Flow Capture

::: warning Experimental
tapflow's **AI agents** (the MCP server) and **Automation** (the flow runner) are experimental. The manual QA dashboard is the most mature part of tapflow; these two are still maturing. Expect rough edges, especially in selector matching and in timing right after an app launches.
:::

A coding agent such as Claude Code can save the path it checked on a device through the [MCP server](/ai-agents/mcp-server) as a [flow](/automation/flows) YAML file. The MCP server records the coding agent's taps, swipes and typing, and `capture_flow` resets the device the way `tapflow flow run` does and replays the flow. It returns the YAML only if that replay passes, and no AI model runs in the replay. It is what [Flow Capture](/testing/flow-capture) does for a teammate in the dashboard, done by a coding agent. A capture opens only when the coding agent passes `capture: true` to `connect_device`.

## How to use {#how-to-use}

Ask your coding agent something like "test the login screen and save the path you checked as a flow". The coding agent learns this order from `get_testing_guide`:

```text
connect_device (capture: true) → open a capture
install_app / launch_app       → launch the app (required once while capturing)
query_ui_tree, tap, type_text  → walk the path (all recorded)
list_captured_steps            → see the numbered steps and what each may expect
capture_flow                   → reset the device, replay the chosen steps, get the YAML if it passes
```

### 1. Open a capture {#start}

`connect_device` with `capture: true` opens a capture on that session. The result's `capture.observing` says whether the device reports what a tap by coordinates hit, and `capture.note` explains the condition ([How steps are named](#how-steps-are-named)).

- One MCP server holds one capture. Opening a new one drops the one before, on whatever device it was.
- Launch the app at least once while capturing (`launch_app`, or `run_flow` with a `buildId`). Every flow begins by launching the app, so `capture_flow` refuses when no build was launched.

### 2. Walk the path {#walk-the-path}

While the capture is open, the MCP server records what the coding agent does on that session:

- A `tap` with `element` is recorded with the selector the coding agent named.
- A `tap` or `swipe` by coordinates is recorded with its points and what the device reported it hit.
- Text typed with `type_text`, screens read with `query_ui_tree`, keys, buttons, installs and launches are recorded.
- The steps of a `run_flow` are recorded as one block of steps the coding agent wrote itself.

While a capture is open, the tools that type work differently, because what is typed may be a password:

- `type_text` does not return the text. It returns its length, the field it went into (`into`: the field's identifier, `(no id)` when it has none, or `null` when no field was focused), and whether that field hides its text (`secure`).
- `run_flow` does not run a flow with an `inputText` step. Text must be typed with `type_text` so the capture can tell a password from plain text.
- `press_key` and a `run_flow` `pressKey` take only keys that type no character: `Enter`, `Return`, `Backspace`, `Delete`, `Escape`, `Tab`, the arrow keys, `Home`, `End`, `PageUp` and `PageDown`.

### 3. Choose the steps {#choose-steps}

`list_captured_steps` shows the recorded steps numbered from 1. Each step has the form it takes in the flow (`step`), where its name came from (`origin`), why it replays by position (`fragile`), and the elements that can be checked after it (`expect`).

`expect` lists only the elements the step brought on screen. An element already on screen before the step proves nothing about the touch, so it is left out and counted in `alreadyShown`. A step that brought nothing new lists all of them with a `before` warning. If only such elements are chosen, the flow counts as having no expectation that checks the touch, and the header comment says so.

The coding agent chooses only these in `capture_flow`. There is no way for it to write YAML here, so every step in the flow is one the coding agent did or the device saw.

| Argument | Meaning |
|---|---|
| `sessionId` | The session to verify on: the capture's, or another of the same platform |
| `name` | The flow's name |
| `from`, `to` | The range of steps to include, by number. All of them when omitted |
| `drop` | Step numbers to leave out |
| `expect` | An element to check after a step: `{ step, candidate }`, a candidate `list_captured_steps` showed |
| `secrets` | A name for a step typed as a secret: `{ step, name }`, such as `APP_PASSWORD` |

### 4. Verify {#verify}

`capture_flow` makes the flow from the chosen steps, resets the device the way `tapflow flow run` does before a run ([Flow Capture's reset](/testing/flow-capture#range)), and replays it on the same engine as CI.

- If it passes, it returns `verified: true` with the YAML (`yaml`) and the contents of its header comment (`notes`).
- If it fails, it returns no YAML: `verified: false`, the failed step's number (`failedStep`, in `list_captured_steps`' numbers), the failure message and the kind of failure (`failureKind`). When a tap found nothing, it also returns selectors that would have found the element on that screen (`suggestions`). The capture stays, so the coding agent leaves that step out and verifies again, or captures the path again. A failed step left out is noted in the YAML's header comment.
- Inputs sent to the device while verifying are not recorded in the capture.
- If the device's agent (the tapflow process on the Mac that runs the simulators and emulators) predates the reset a run does, only the app's data is cleared before the replay, and the result's `resetNote` says so.

### 5. Save the flow {#save}

Save the YAML the coding agent received in your app repository, for example as `.tapflow/flows/<name>.yaml`, and CI runs it with `tapflow flow run`. The YAML has already passed its replay, so keep it as it is. For a flow with a secret, pass the value with `--secret` when it runs ([Secrets](#secrets)).

## Read the header comment {#header-comment}

The YAML `capture_flow` returns says where it came from and what was left out in a comment at the top. The person reviewing the file in a pull request never sees the answer the coding agent got, so what the review needs is kept in the file.

```yaml
# Captured from an AI agent's session over MCP, verified on try 1: 8 steps recorded.
# Left out by the agent: #2, #3

name: sign-in
appId: com.example.app
steps:
  - clearState
  - launchApp
  - tapOn:
      id: email
  - inputText: qa@example.com
  - tapOn:
      id: password
  - inputText:
      secret: APP_PASSWORD
  - tapOn:
      id: sign_in
  - assertVisible:
      label: Welcome back
      exact: true
```

| Comment | Meaning |
|---|---|
| `Captured from an AI agent's session over MCP, verified on try N: M steps recorded.` | Which Verify passed, and how many steps were recorded |
| `Outside the range (a–b): ...` | Steps outside the chosen range |
| `Left out by the agent: ...` | Steps the coding agent left out |
| `Left out after they failed in an earlier Verify (dropped-after-verify-failure): ...` | Steps left out after an earlier Verify failed on them |
| `Fragile: #N reason` | A step replayed by its position on the screen rather than an element, and why |
| `The touch was seen to hit another element than the agent named: ...` | The device saw the touch hit another element than the one the coding agent named. An overlay you cannot see may be covering it |
| `Written by the agent (run_flow), not observed: N blocks` | How many blocks of steps the coding agent wrote itself with `run_flow` |
| `Not named by an element whose name holds a typed secret: ...` | A step named another way than by an element showing a secret's value |
| `Left out, a step holding a typed secret: ...` | A step left out because it held a secret's value |
| `Warning: no expectation — the flow checks only that each step could be done` | No expectation: the flow checks only that each step could be done |
| `Warning: N of M steps left out` | Three or more steps, or at least half of the steps that act, were left out |

The comment is for the review. Reading the flow ignores it.

## How steps are named {#how-steps-are-named}

Each step is named by what was known when it was done. Nothing is replayed beforehand to find the names.

1. **A tap on an element** uses the selector the coding agent named. If the device reports the touch hit another element, the selector stays and the header comment says so.
2. **A tap by coordinates** uses the element the device reported it hit, when the screen read just before the tap finds that element alone and the element's centre is that element.
3. Otherwise, it uses the element at that point on the screen read just before the tap.
4. Failing that, it stays a position on the screen, marked `fragile`. A flow with position steps carries the size of the capture's screen as `viewport`, and a device of another size is refused before the run.

A swipe that brought the next tapped element on screen becomes `scroll { until }` and replays whatever the distance. Any other swipe stays a position step.

Typed text is written into the flow as it is only when the screen read just before typing found one focused field that does not hide its text (`secure: false`). If the screen was not read, no field was focused, the field hides its text, or the text holds a Tab or a Return, it is treated as a secret. So tap the field, read the screen with `query_ui_tree`, then type, and plain text stays plain.

## Secrets {#secrets}

Text treated as a secret is not written in the flow file. The flow keeps only an `inputText: { secret: NAME }` step, and you pass the value with `--secret NAME` when you run `tapflow flow run` ([Secrets in the flow reference](/automation/flows#secrets)).

- Name it with `capture_flow`'s `secrets`. Unnamed, it is `PASSWORD` when the field said it hides its text and `SECRET` otherwise, numbered from the second.
- A name starts with a letter or `_` and holds only letters, digits and `_`. One name holds one value, so giving the same name to two steps that typed different values is refused.
- A secret's value is used only for Verify, and is in neither the YAML nor the result the coding agent gets.
- An element that shows a secret's value on screen (a Copy button showing the token just typed, say) is not offered as an expectation and does not name a tap. Such a step is named another way or left out, and the header comment says so.

## Edit a captured flow {#edit-a-captured-flow}

To add what the capture cannot make from taps and typing (`assertNotVisible` for a spinner or error that should be gone, a `timeout` for a slow step), or to repair a flow that failed in CI, edit the YAML yourself:

1. End the capture with `connect_device` and `capture: false`. While a capture is open, `run_flow` does not run a step that types text.
2. Edit the YAML.
3. Replay it twice with `run_flow` and keep it only if both pass.

`run_flow` is given no secrets, so a flow that types a secret cannot be replayed this way. Capture such a flow again instead of editing it.

## Platform support {#platform-support}

The device reporting what a tap by coordinates hit (observation) needs the relay and the agents from 0.34. Without it, `connect_device`'s `capture.observing` is `false`, and a tap by coordinates is named by the screen read just before it, or kept as a position.

| | iOS | Android |
|---|---|---|
| Capture and Verify | Supported | Supported |
| Observing taps by coordinates | Only in an app process started after the capture opened | Taps sent over the emulator's gRPC path. A touch sent through the adb fallback is not observed |

An iOS app reads its accessibility setting when it starts, so taps in an app already running before the capture opened are not observed. Install the app again, or launch it again with `launch_app` and launch arguments, after opening the capture. A tap that was not observed can still be named by the screen read before it, and Verify starts from a reset device either way.

## Limits {#limits}

- A capture lives only in the MCP server process's memory and is never written to disk or a log. The relay stores none of it either.
- A capture stays while you hold the device. After `disconnect_device` lets the device go, it is dropped an hour later; connecting to the same device again before then restarts that hour from the next release. It is also dropped when a new capture opens, when `capture: false` ends it, or when the MCP server process ends.
- Verify resets the device before it replays. On iOS that resets the keychain, privacy permissions, clipboard and location of every app on the device, so do not use one whose other apps must stay signed in.
- On Android, while observing, a coding agent's tap is lifted only once the device knows what it touched, at most a quarter of a second later. A person's taps, drags and flings are not delayed.
- The steps the capture makes from taps and typing have no `assertNotVisible` and no `timeout`. Steps from a `run_flow` are kept as written, so one the coding agent wrote with them keeps them. Add them elsewhere as in [Edit a captured flow](#edit-a-captured-flow).
- If the app was launched with launch arguments, the flow's `launchApp` does not carry them. `list_captured_steps` says so.

## Troubleshooting {#troubleshooting}

| Symptom | Cause and fix |
|---|---|
| `no capture is open — connect_device with capture: true, then use the device` | No capture is open. None was opened, an hour passed after the device was let go, a new capture or `capture: false` dropped it, or the MCP server restarted. Open a capture and walk the path again. |
| `the flow launches the app, and no build was launched while capturing` | The app was not launched while capturing. Launch it with `launch_app`, then verify again. |
| `cannot reset the app of build ... so it was not verified` | The relay could not give the build's bundle id, so the app could not be reset. A flow that passes without a reset can fail in CI, so it is not verified. |
| `the device's reset failed for ..., so the flow was not verified` | Part of the reset failed. Try again, or reboot the device. |
| `verified: false` with `refused: [...]` | A choice does not hold: `bad-range` (the range is outside the list), `out-of-range` (no such step), `failed-block` (a step past where its `run_flow` failed), `no-candidate` (an expectation not offered, or on a step left out), `not-secret` (a name for a step not typed as a secret), `bad-secret-name`, `secret-name-taken` (one name for two values), `nothing-done` (nothing but launching the app). |
| `run_flow` refuses with `while a capture is open, type with type_text` | Type with `type_text` while capturing. To replay an edited flow, end the capture first with `capture: false`. |
| `press_key` refuses with `while a capture is open, only keys that type no character are pressed` | Type characters with `type_text`. |

## Related {#related}

- [MCP server](/ai-agents/mcp-server): installing it, connecting a coding agent, and the tools
- [Flow Capture](/testing/flow-capture): how a teammate saves their own steps as a flow in the dashboard
- [Flow reference](/automation/flows): the flow file format, `tapflow flow run` and secrets
- [Flow Runs](/automation/runs): the results of flows run in CI
