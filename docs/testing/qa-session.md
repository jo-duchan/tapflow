---
title: QA Session
description: "Pick a Mac and a device to start a session and drive the device screen from your browser. Every feature a session offers, with a link to its own page."
---

# QA Session

A QA Session is where you watch and drive an iOS simulator or Android emulator running on a Mac, straight from your browser. The device runs on your operator's Mac, so teammates install nothing. It opens when you press **Start QA** on a build's row in [App Center](/testing/app-center).

## Start a session {#start-a-session}

### Pick a Mac {#select-mac}

**Select Mac** shows a card for each Mac that has devices for this platform. Each card has the Mac's name, a status dot, its free slots (free/total, such as `2/4 slots`), and its CPU and RAM usage.

| Status dot | Meaning |
|---|---|
| Green | Plenty of headroom |
| Yellow | CPU or RAM from 70% up to 80% |
| Red | CPU or RAM over 80%. Over on CPU, the card cannot be picked. Over on RAM only, it can be picked while one of its devices is already on |
| Grey | No usage report, or none for over 30 seconds. The card shows **Stale** |

Hovering a red card shows **This Mac is currently overloaded. Try again later.** Pick another Mac or try again shortly.

While a device is starting on that Mac, the card shows **Starting a device**, and you can pick it even with CPU over 80%, because the starting device is what raised it. A Mac starts one device at a time, so if the device you pick needs starting, the info card shows **Another device is starting on this Mac. Yours starts next…** and it starts within 60 seconds. When the Mac is critically short of memory, the card shows **This Mac is low on memory. Yours starts when it frees up…** instead, with the same 60-second limit.

### Pick a device {#select-device}

Click a device under **Select device** to start the session. Each device shows its state.

- **Booted**: already running.
- **Available**: shut down and free. Picking it boots it.
- **In use**: another teammate is using it, so it cannot be picked.
- **Your session is waiting for you**: your session on this device dropped and is waiting for you. Pick it to carry on with the app as you left it.
- **Waiting for … to return**: a teammate's connection dropped and the device is waiting for them. Picking it shows whose session it is and how long until the device shuts down, and asks you to confirm. Once you use it, their session ends and the app state they were testing is gone. If they come back within the time the device would have waited for them, they are told who is using it.
- **Not enough memory to start**: the Mac's RAM is over 80%, so this device cannot be started. A device tapflow already has running can still be picked.

A running device marked **Most services off** was started by an automated run with most background services turned off (`--service-tier slim`), apart from any it asked to keep. It stays that way until it restarts: pick it and restart it from the toolbar to turn them back on. The info card says so too.

Find a device with **Search device…**, by the name an Admin gave it or by its own name. Narrow the list with the OS version filter (default **Any version**). With **Any version**, the list is split under a heading per OS version, newest first; a list with a single group has no heading. Devices whose version is unknown are gathered under **Other** at the bottom. An Android emulator is grouped by its system image's version even while it is off.

Turn on **Full reset** before picking a device to erase all of its data first, other apps included. Even with it off, the build under test is installed fresh at every session start, so that app always starts with its data cleared. [Returning to a session](#return-to-a-session) does not reinstall it. It applies once: the switch turns itself off the moment you pick a device. The switch appears only when the Mac supports resetting.

### Organize the device list {#organize-devices}

Simulators and emulators you add to or delete from the Mac show up in the list without restarting the agent. The agent re-reads its device list every 30 seconds, so a device appears or disappears within about 35 seconds. A device someone is using leaves the list after their session ends. Both the relay and the agent need to be on a version that includes this.

- **Favourites**: Click the star on a device card to move the device into the **Favourites** group at the top of the list. Each person has their own favourites.
- **Rename** (Admin): Choose **Rename** from the card's ⋯ menu. Every teammate's list shows the new name, with the original name in small type underneath. Save an empty name to go back to the original.
- **Hide** (Admin): Choose **Hide** from the ⋯ menu to take the device out of every teammate's list. Admins can turn on the **Show hidden** switch to see hidden devices, and choose **Show** from the ⋯ menu to bring one back.

Names and hidden devices are stored on the relay; the simulators and emulators on the Mac don't change. They apply only to the dashboard's list, so MCP clients and automated runs keep using hidden devices under their original names.

### Launch the app {#launch}

Once the device is up, the build is installed on it automatically. The info card to the right of the device shows progress such as **Starting device…** and **Installing app…**. When the install finishes, a **Launch app** button appears in the toolbar; press it to run the app. See [Device controls](/testing/device-controls#launch-the-app).

### Leave a session {#leave-a-session}

The breadcrumb at the top reads `app name › build › Mac › device`. Click an earlier step to go back to it. Leaving the device screen shuts that device down, so another teammate can use it straight away.

If you close the browser tab or lose your connection, the device does not shut down straight away. It waits for you for a few minutes (5 by default). See [Return to a session](#return-to-a-session).

### Return to a session {#return-to-a-session}

When you pick a device, the URL in the address bar holds the session. Reload or reopen that URL and you are back on the same device without picking it again. If the same build is still on the device, it is not reinstalled, so app state such as a login carries over. The same goes for a connection that drops for a moment and comes back.

If your connection drops or you close the tab, the device waits for you for a set time (5 minutes by default) and then shuts down. Until then you can come back in either of these ways:

- Open the same URL.
- Press **Resume** on the **Your session on … was interrupted** notice above App Center or the device list. This works from another browser too, as long as you are signed in to the same account. Press **End** to shut the device down now.

When you come back through the URL, the dashboard tells you what it found:

| Situation | What you see |
|---|---|
| You reloaded while your connection was down, so your earlier tab's connection is still there. | A **Returning to your session on …** notice. The session continues on its own once the earlier connection is cleared, within about 45 seconds. You can pick another device while you wait. |
| The same session is still open in another of your tabs. | The same notice. The session continues here once that tab is closed. If it is still open after about 45 seconds, you are told it is open in another tab. |
| The device has already shut down. | A **Start … again?** dialog. Starting again installs the build from scratch. |
| A teammate started using the device. | A notice saying who is using it, and the device list. |
| An AI client is using the device for a while. | A notice saying so. You can carry on when it is done. |

If the device was shut down and started again outside tapflow (by quitting Simulator.app, for example), the build is reinstalled when you come back. If you deleted the app on the device yourself, the app is not there when you come back, so pick the device again to install it.

## What you can do in a session {#features}

| Feature | What it does |
|---|---|
| [Touch and gestures](/testing/device-controls#touch-and-gestures) | Click to tap, drag to swipe. Hold Option (Alt) and drag to pinch. |
| [Typing](/testing/device-controls#typing) | Click the device screen once, then type. |
| [Launch the app](/testing/device-controls#launch-the-app) | Run the installed build with **Launch app**. |
| [Device buttons](/testing/device-controls#device-buttons) | Press iOS Home and the side buttons on the device frame, or Android **Home**, **Back**, **Recent Apps**, **Volume Up**, **Volume Down** and **Power**. |
| [Software keyboard](/testing/device-controls#software-keyboard) | Show or hide the iOS on-screen keyboard. |
| [Rotate](/testing/device-controls#rotate) | Turn the device a quarter clockwise on iOS and on an Android emulator started with gRPC. A real Android device or an emulator started without gRPC switches between portrait and landscape. |
| [Fold and unfold](/testing/device-controls#fold) | Fold or unfold a foldable Android emulator or an iPhone Duo. |
| [Restart the device](/testing/device-controls#restart) | Restart the device. The build under test is reinstalled; other apps keep their data. |
| [Clipboard](/testing/device-controls#clipboard) | Copy and paste text between the device and your computer. |
| [Deep links](/testing/deep-links) | Open a specific screen of the app from a URL. |
| [Network control](/testing/network-control) | Take the device offline and bring it back. |
| [Audio](/testing/audio) | Hear the device in your browser. |
| [Screenshots](/testing/screenshots-and-recordings#screenshots) | Download the device screen as a PNG. |
| [Recordings](/testing/screenshots-and-recordings#recordings) | Record the device screen as a video and share it with the team. |
| [Comments](/testing/comments) | Leave notes and images on the build. |
| [Keyboard shortcuts](#keyboard-shortcuts) | Run common actions with one key combination. |

The buttons sit in the toolbar to the right of the device, in four groups: Navigation, Device, Capture and Environment. A button for a feature the Mac does not support is not shown.

## Info card {#info-card}

The info card to the right of the device shows the session's state.

- **Focus**: turns green while your keystrokes go to the device.
- **fps**: frames per second arriving. Above 15 it reads **Active**, otherwise **Idle**. A low number is normal while the screen is still.
- **Smooth** / **Standard**: the stream profile this browser gets. Click **Standard** for a dialog on what it takes to switch to Smooth. See [Stream quality](/operate/streaming-quality) for the profiles.

The tabs under the card hold [Comments](/testing/comments) (**Comments**) and [Recordings](/testing/screenshots-and-recordings#recordings) (**Recordings**).

## Keyboard shortcuts {#keyboard-shortcuts}

These shortcuts do not fire while the cursor is in one of the dashboard's text fields.

| Shortcut | Action | Platform |
|---|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> | Open the [deep link](/testing/deep-links) box | iOS, Android |
| <kbd>⌘</kbd> <kbd>S</kbd> | [Screenshot](/testing/screenshots-and-recordings#screenshots) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Y</kbd> | Start or stop a [recording](/testing/screenshots-and-recordings#recordings) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd> | [Rotate](/testing/device-controls#rotate) | iOS, Android |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd> | [Home button](/testing/device-controls#device-buttons) | iOS |
| <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd> | Show or hide the [software keyboard](/testing/device-controls#software-keyboard) | iOS |
| <kbd>⌥</kbd> + drag | [Pinch](/testing/device-controls#touch-and-gestures) | iOS, Android |
| <kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>C</kbd>·<kbd>X</kbd>·<kbd>V</kbd> | [Clipboard](/testing/device-controls#clipboard) copy, cut and paste | iOS, Android |

Any other key goes to the device once you have clicked its screen.

## Limits {#limits}

- One person uses a device at a time. A device someone else is using shows **In use** and cannot be picked.
- Leaving the device screen shuts the device down. Whatever was open on screen is gone and other apps keep their data. The build under test is installed again when the next session starts, so its data does not carry over.

## Troubleshooting {#troubleshooting}

When a session drops, the dashboard says why in a notice and returns to the Mac list.

| Notice | Cause and what to do |
|---|---|
| **`The agent disconnected — this session ended.`** | The Mac's connection dropped. Pick the Mac again to start a new session. |
| **This device is already open in another browser session.** | Someone else is using the device. If you reloaded while your connection was down, your own earlier tab is holding it, and it clears within about 45 seconds. |
| **That Mac is too busy to start a session.** | The Mac's CPU or RAM is over the limit. Pick another Mac or wait a moment. |

If the stream stalls or lags, see [Stream & sessions troubleshooting](/troubleshooting/streaming).

## Related {#related}

- [App Center](/testing/app-center): picking a build and changing its review status
- [Device controls](/testing/device-controls): touch, buttons, rotation, the clipboard and the rest
- [Stream quality](/operate/streaming-quality): how the Smooth and Standard profiles differ
