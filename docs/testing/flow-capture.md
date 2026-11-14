---
title: Flow Capture
description: Save the taps, swipes and typing you did in a QA Session as a flow YAML. tapflow replays them on the device to name what each one touched, checks the flow the way tapflow flow run will, and hands you the file.
---

# Flow Capture

<Badge type="info" text="iOS" /> <Badge type="info" text="Android" />

Save the taps, swipes and typing you did in a [QA Session](/testing/qa-session) as a [flow](/automation/flows) YAML file. CI then repeats them with `tapflow flow run`. You do not write the flow file by hand, and no AI model runs when it replays. Recording your steps is on by default, and each teammate can turn it off.

## How to use {#how-to-use}

### 1. Turn on step capturing {#turn-on}

Click your name at the bottom of the sidebar, choose **Settings**, and check that **Capture my steps** is on in the **Flow Capture** card. While it is, your taps, swipes and key presses in a QA Session are kept in the memory of the relay (the server that connects the dashboard and the agents), with a small picture of the screen as each step began. No picture is kept of a key pressed on the on-screen keyboard, since that screen shows what you just typed, nor of a step begun within 2 seconds of typing into a password field, which can still show the last character. The session's info card shows **Steps · On** while it records and **Steps · Off** when it is off.

Test as usual. A run you want to keep as a flow is easier to pick out later if you start it with the toolbar's **Launch app** button.

### 2. Open Capture flow {#open}

Click **Capture flow** in the toolbar's Capture group. The dialog has five steps: **Range**, **Match**, **Edit**, **Verify** and **Export**. Unless something is replaying on the device, you can go back to a step you have already passed (except Match) from the progress bar at the top.

### 3. Range: pick the part {#range}

The steps you took are shown as a strip, each with a small picture of the screen as it began; a key pressed on the on-screen keyboard shows **On-screen keyboard** instead of a picture. A frame marks the part that becomes the flow. It starts out from the first launch after the app was last installed or cleared to your last step.

- Drag the handles at either end to move the start and the end. With a handle focused, the arrow keys move it one step at a time.
- **drop first** and **drop last** take the first or last step out, one at a time.
- Fill in **Name** and, optionally, **Tags** (comma-separated). The name becomes the file name you export.

If you typed into a password field on the on-screen keyboard, each such step gets a field such as **Password for step 7**. A password field cannot be read, so you enter the value the replay should type, and **Continue** waits for it. What you typed on your computer's keyboard is filled in. The value is used for this replay only and never saved.

If you opened the app from its icon on the home screen, the part starts at the first step you took in the app, and the swipes and taps you made on the home screen to find it are left out. If the first step is not a launch and cannot be told to be in the app, the flow launches the app itself, and the dialog tells you to leave out any tap on the home screen before it. If nothing cleared the app before that launch, it also tells you the steps ran on data an earlier test left.

**Continue** resets the device the way `tapflow flow run` does before a run, then replays the steps in the next step. On iOS the app is reinstalled, the keychain, privacy permissions, clipboard and location are reset for every app on the device, so other apps are signed out too, and the device is turned upright. On Android the app's data is cleared, and on an emulator the clipboard is emptied and the device turned upright. On both, a device taken offline goes back online.

### 4. Match: replay and name the steps {#match}

tapflow resets the same device that way, turns it the way it was when the part started, launches the app, and replays the steps you picked one by one. It shows what was reset, and anything that could not be. It also sets the keyboard language the recording used. Before each step it reads the screen and finds the name (selector) of what the step touched. Progress shows as **Step 3 of 12**, and the device on the left shows where each step touches as a blue dot and trail.

A typing step replaces what the field holds with the value the field really held when you recorded: Korean, Caps Lock, the on-screen keyboard and Backspace all replay as they ended up. If you typed into a field that was focused before the part began, the replay taps that field first, and the tap goes into the flow.

Just before each step runs, the screen is compared with the one the step began on when you recorded it. When the two differ, the replay stops at that step and shows the recorded picture beside the screen now, and says so if steps you took come before the part. The status bar, and the area the on-screen keyboard covered when you recorded, are not compared, and are marked on the pictures with a light gray tint and a dashed edge. A step with no picture (a key on the on-screen keyboard, a step begun right after typing a password) is not compared.

- **Continue anyway** runs that step and goes on replaying. Verify then runs the flow with selectors only, so a step whose element is not on the screen fails there; it does not compare the screen with the recording.
- **Back to Range** returns to Range. When the start is still where it began and steps you took in the app come before it, the start moves back to them, and Range says so.
- **Edit what matched** appears only when some steps matched, and goes on to Edit with those steps.
- **Stop** halts the replay. Then **Start again** replays from the beginning, and **Edit what matched** goes on with the steps matched so far.
- Step capturing pauses while it replays, so the replayed steps do not end up in your capture.

### 5. Edit: tidy up the steps {#edit}

The steps of the flow are listed. Selecting one shows its screenshot on the left, with where it touched: after the typing for a typing step, before it for a password, and just before the step for the rest.

- Remove a step you do not want (a mistaken tap, for example) with its trash button.
- A badge tells you about a step.

| Badge | Meaning |
|---|---|
| **fragile** | A tap that taps a point on the screen because nothing there can be named, or a swipe that replays its two ends at the speed it was made. A different screen size or layout can make it land elsewhere. Also a tap that may have been a key on the on-screen keyboard or the app, and typing whose field could not be read afterwards. |
| **auto** | A swipe turned into "scroll until the element the next step taps is on screen" (`scroll: { until }`). How far one swipe goes differs from run to run, and this way the result does not. |
| **not in the flow** | Something a flow cannot express, left out: switching the network, cut, putting the on-screen keyboard up or down, a long press of more than 60 seconds, a key on the on-screen keyboard whose typing could not be read, and so on. The card says why. |

Keys tapped on the on-screen keyboard are not kept one by one: they go into the field's single typing step. A Done or Search key that put the keyboard away becomes an `imeAction` step.

Text typed into a field the app marks as a password, on either keyboard, is not written to the flow file. The step keeps only a name, as in `inputText: { secret: PASSWORD }`. Text typed into a field the app does not mark as a password (a card number, an API key, a password shown as plain text after tapping a show-password button) goes into the file as text. Open such a typing step's card and press **Make secret** to keep only a name such as `SECRET` in its place. The recorded value is typed on the device by Match and Verify and never written to the file. **Keep as text** puts it back. Before you commit the file, check that the YAML holds no secret value. Open the card with its expand button to rename it; a name uses letters, digits and `_` and does not start with a digit. Renaming a secret to a name another secret has joins the two only when their values are the same, as with a password and its confirmation; with different values the rename is refused. To pass the value when the flow runs, see [Secrets](/automation/flows#secrets).

A recording keeps what you tapped, not what you saw that told you it worked. Selecting a tap step shows **At this tap** and **After this tap** above the picture; **After this tap** is the screen right after the tap. Click an element on it and choose **Add** to expect it after the tap, under **Expected** on the card. An expected element goes into the file as an `assertVisible` right after the tap, matching the whole label (`exact: true`), so it can check a value such as a total or a count. An input field, the on-screen keyboard, and text that holds a secret's value cannot be picked. An element already on the screen before the tap, or a time or date, can be picked with a warning. Click a chip to see its element on the screen, and × to remove it. A step that finds its element by its place among elements alike carries a **by position** badge.

**Show YAML** previews the flow. **Verify and export** moves on.

### 6. Verify: check the flow {#verify}

The edited flow runs from the start on the same device, after the same reset, this time with selectors only and not the recorded points, on the same engine as `tapflow flow run` in CI. The steps appear as they run, each marked passed or failed with how long it took.

Match and Verify also watch how the screen changes after each touch. Export writes what both saw (what Verify saw, for a touch Match did not watch) beside each step as its `expect`, so a later run fails when the touch no longer makes the same change ([Expected effects](/automation/flows#expected-effects)). Open a step to see what a run will check.

- A touch after which nothing on the screen changed stays open with **Nothing on the screen changed after this touch**. If the touch should have changed something, an overlay you cannot see may be covering the element.
- A step whose touch the device could not judge also opens with the reason ([Where a touch lands](/automation/flows#where-a-touch-lands)).
- If it passes, **Continue** moves on.
- If it fails, the failed step opens to show why. When a tap found nothing, it also offers selectors that would have found the element on that screen. **Back to Edit** goes back to fix it, and **Export anyway** exports it as it is.

### 7. Export: save the file {#export}

The file name (`flows/<name>.yaml`) and the YAML are shown.

- **Download** saves the file, and **Copy YAML** copies it. Copying works only on a dashboard opened over HTTPS or on localhost. Over any other HTTP address, the button selects the YAML for you to copy with the keyboard.
- Put the file in your app repository and CI runs it with `tapflow flow run`. The CI examples keep flow files under `.tapflow/flows/`. See [Flows](/automation/flows).
- If the flow has secrets, the `--secret` options to pass when it runs are shown.
- After a Verify, each touch carries an `expect`, and a flow with point steps carries the size of the device Verify ran on as `viewport`. Editing a step drops the Verify result, so verify again to have them written.
- The exported flow starts by clearing the app's data (`clearState`) and launching it (`launchApp`), and runs only against builds of this app (its bundle id or package name). If the part began with the device turned sideways, the flow turns it with `setOrientation: landscape` after the launch. If the build's bundle id could not be read, Range says so, and the flow neither clears the app's data nor is tied to one app.

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
- Match and Verify reset the device before they replay. On iOS that resets the keychain, privacy permissions, clipboard and location of every app on the device, so do not use one whose other apps must stay signed in.
- On iOS, the field's value and the on-screen keyboard's position are read from inside the app under test, so the app does not slow down. A field inside a web page (WebView) cannot be read, so what is typed there is treated as a secret. The value read passes through a file in the Mac's temporary folder that only the agent's user can read, and the agent deletes it as soon as it has read it, or within a few seconds when it arrives too late to be read. On a Mac over its memory limit no field is read.
- On iOS, when a person whose steps are recorded boots a device, the simulator's app accessibility setting (`ApplicationAccessibilityEnabled`) is turned on: the app needs it to say what each tap touched. The name and identifier of what a tap touched (never what a field holds) pass through a file in the simulator's temporary folder that only the agent's user can read, deleted when the agent reads it, and are kept in the capture beside the step. The setting's previous value is kept on the Mac and put back at the next boot that is not recorded, or before the device shuts down; if the agent stopped first, when it next starts while the device is running, otherwise at the device's next boot. A simulator that already had it on is left alone. The setting takes effect when an app launches, so an app already running at the boot gets it from its next launch, and turning off **Capture my steps** during a session leaves it on until the next boot.
- Replaying a typing step by replacing the field's contents needs Android 13 or later, and `imeAction` Android 11 or later. See [Flows](/automation/flows).
- An element covered by an overlay with no accessibility information is invisible when the device judges where a touch lands. Suspect one when Verify says a touch changed nothing. See [Where a touch lands](/automation/flows#where-a-touch-lands).
- Every role can use it, Viewer included.

## Troubleshooting {#troubleshooting}

| Symptom | Cause and fix |
|---|---|
| There is no **Capture flow** button in the toolbar. | **Capture my steps** is off, or the session was opened without a build. If the info card shows **Steps · Off**, turn it on in the **Flow Capture** card in **Settings → Default**. |
| **No steps have been captured on this device yet.** | No steps were recorded on this device. Turn on **Capture my steps** and test. |
| **Your captured steps are gone: the device was released or restarted.** | The device was shut down or restarted, which cleared the capture. Test again to record it. |
| **The connection to the relay was lost. Start again once it is back.** | The connection to the relay dropped. Click **Start again** once it is back. |
| **Capturing could not be paused, so the replay stopped — its steps may now be mixed into your capture.** | Capturing could not be paused while it replayed. The replayed steps may be in your capture, so check the range again. |
| **This device’s tapflow agent cannot reset it the way a run does.** | tapflow on that Mac predates the reset. The replay ran with at most the app's data cleared, so its result may differ from CI's. Update tapflow on that Mac. |

## Related {#related}

- [Flows](/automation/flows): the flow file format, `tapflow flow run` and secrets
- [QA Session](/testing/qa-session): what a session offers and its info card
- [Device controls](/testing/device-controls): how to tap, swipe and type in a session
