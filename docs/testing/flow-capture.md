---
title: Flow Capture
description: Save the taps, swipes and typing you did in a QA Session as a flow YAML. tapflow replays them on the device to name what each one touched, checks the flow the way tapflow flow run will, and hands you the file.
---

# Flow Capture

<Badge type="info" text="iOS" /> <Badge type="info" text="Android" />

Save the taps, swipes and typing you did in a [QA Session](/testing/qa-session) as a [flow](/automation/flows) YAML file. CI then repeats them with `tapflow flow run`. You do not write the flow file by hand, and no AI model runs when it replays. Recording your steps is on by default, and each teammate can turn it off.

## How to use {#how-to-use}

### 1. Turn on step capturing {#turn-on}

Click your name at the bottom of the sidebar, choose **Settings**, and check that **Capture my steps** is on in the **Flow Capture** card. While it is, your taps, swipes and key presses in a QA Session are kept in the memory of the relay (the server that connects the dashboard and the agents). The session's info card shows **Steps · On** while it records and **Steps · Off** when it is off.

Test as usual. A run you want to keep as a flow is easier to pick out later if you start it with the toolbar's **Launch app** button.

### 2. Open Capture flow {#open}

Click **Capture flow** in the toolbar's Capture group. The dialog has five steps: **Range**, **Match**, **Edit**, **Verify** and **Export**. Unless something is replaying on the device, you can go back to a step you have already passed (except Match) from the progress bar at the top.

### 3. Range: pick the part {#range}

The steps you took are shown as a strip, and a frame marks the part that becomes the flow. It starts out from the first launch after the app was last installed or cleared to your last step.

- Drag the handles at either end to move the start and the end. With a handle focused, the arrow keys move it one step at a time.
- **drop first** and **drop last** take the first or last step out, one at a time.
- Fill in **Name** and, optionally, **Tags** (comma-separated). The name becomes the file name you export.

If the part does not start with a launch, the flow launches the app itself, and the dialog tells you to leave out any tap on the home screen before it. If nothing cleared the app before that launch, it also tells you the steps ran on data an earlier test left.

**Continue** clears the app's data on the device and replays the steps in the next step, so an account that was signed in is signed out.

### 4. Match: replay and name the steps {#match}

tapflow clears the app's data on the same device, turns the device the way it was when the part started, launches the app, and replays the steps you picked one by one. Before each one it reads the screen and finds the name (selector) of what the step touched. Progress shows as **Step 3 of 12**, with the device on the left.

- **Stop** halts the replay. Then **Start again** replays from the beginning, and **Edit what matched** goes on with the steps matched so far.
- Step capturing pauses while it replays, so the replayed steps do not end up in your capture.

### 5. Edit: tidy up the steps {#edit}

The steps of the flow are listed. Selecting one shows the screen just before it was replayed.

- Remove a step you do not want (a mistaken tap, for example) with its trash button.
- A badge tells you about a step.

| Badge | Meaning |
|---|---|
| **fragile** | A tap that taps a point on the screen because nothing there can be named, or a swipe that replays its two ends at the speed it was made. A different screen size or layout can make it land elsewhere. Text typed with Caps Lock on is marked too: depending on the device, Caps Lock switches the keyboard's language rather than its case, so what the device typed may differ. |
| **auto** | A swipe turned into "scroll until the element the next step taps is on screen" (`scroll: { until }`). How far one swipe goes differs from run to run, and this way the result does not. |
| **not in the flow** | Something a flow cannot express, left out: switching the network, cut, putting the on-screen keyboard up or down, a long press of more than 60 seconds, and so on. The card says why. |

Text typed into a field the app marks as a password is not written to the flow file. The step keeps only a name, as in `inputText: { secret: PASSWORD }`. A password shown as plain text, as after tapping a show-password button, is an ordinary field and goes into the file as text, so keep it hidden while you record or remove that step. Before you commit the file, check that the YAML holds no password. Open the card with its expand button to rename it; a name uses letters, digits and `_` and does not start with a digit. To pass the value when the flow runs, see [Secrets](/automation/flows#secrets).

**Show YAML** previews the flow. **Verify and export** moves on.

### 6. Verify: check the flow {#verify}

The edited flow runs from the start on the same device, this time with selectors only and not the recorded points, on the same engine as `tapflow flow run` in CI. Each step is marked passed, failed or not run.

- If it passes, **Continue** moves on.
- If it fails, the failed step and the reason are shown. **Back to Edit** goes back to fix it, and **Export anyway** exports it as it is.

### 7. Export: save the file {#export}

The file name (`flows/<name>.yaml`) and the YAML are shown.

- **Download** saves the file, and **Copy YAML** copies it. Copying works only on a dashboard opened over HTTPS or on localhost. Over any other HTTP address, select the YAML and copy it yourself.
- Put the file in your app repository and CI runs it with `tapflow flow run`. The CI examples keep flow files under `.tapflow/flows/`. See [Flows](/automation/flows).
- If the flow has secrets, the `--secret` options to pass when it runs are shown.
- The exported flow starts by clearing the app's data (`clearState`) and launching it (`launchApp`), and runs only against builds of this app (its bundle id or package name). If the build's bundle id could not be read, Range says so, and the flow neither clears the app's data nor is tied to one app.

**Done** closes the dialog. What you did not export is gone with it, and your capture stays until the session ends, so you can open the dialog again.

## Platform support {#platform-support}

| | iOS | Android |
|---|---|---|
| Step capturing | Supported | Supported |
| Capture flow dialog | Supported | Supported |

## Limits {#limits}

- A capture lives only in the relay's memory and is never written to disk or a log. Only the person who made it can read it, from their own browser.
- A capture lasts as long as the session. It is cleared when the device is shut down or restarted, when you leave the session and the device shuts down, when you turn off **Capture my steps**, or when an MCP client takes over the device.
- A session keeps about 20,000 inputs (about 4 MB). Past that, the points in the middle of drags go first, then the oldest steps. App launches, installs and clears are never dropped.
- Match and Verify clear the app's data on the device before they replay.
- Every role can use it, Viewer included.

## Troubleshooting {#troubleshooting}

| Symptom | Cause and fix |
|---|---|
| There is no **Capture flow** button in the toolbar. | **Capture my steps** is off, or the session was opened without a build. If the info card shows **Steps · Off**, turn it on in the **Flow Capture** card in **Settings → Default**. |
| **No steps have been captured on this device yet.** | No steps were recorded on this device. Turn on **Capture my steps** and test. |
| **Your captured steps are gone: the device was released or restarted.** | The device was shut down or restarted, which cleared the capture. Test again to record it. |
| **The connection to the relay was lost. Start again once it is back.** | The connection to the relay dropped. Click **Start again** once it is back. |
| **Capturing could not be paused, so the replay stopped — its steps may now be mixed into your capture.** | Capturing could not be paused while it replayed. The replayed steps may be in your capture, so check the range again. |

## Related {#related}

- [Flows](/automation/flows): the flow file format, `tapflow flow run` and secrets
- [QA Session](/testing/qa-session): what a session offers and its info card
- [Device controls](/testing/device-controls): how to tap, swipe and type in a session
