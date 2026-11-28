---
title: Device controls
description: "Driving the device in a QA Session with mouse and keyboard: touch and gestures, typing, launching the app, device buttons, the software keyboard, rotation, folding, restarting, and the clipboard."
---

# Device controls

You drive the device in a [QA Session](/testing/qa-session) with your mouse and keyboard, much like a phone in your hand. There is nothing to turn on: it works as soon as the session starts. The buttons are in the toolbar to the right of the device, and hovering one shows its name and shortcut.

## Touch and gestures {#touch-and-gestures}

- **Tap**: click the device screen.
- **Swipe**: click and drag.
- **Pinch**: hold Option (Alt) and drag. Pressing the key shows where the two fingers are, and dragging moves them apart or together. Releasing the key ends the pinch.

## Typing {#typing}

Click the device screen once and your keystrokes go to the device from then on. The **Focus** label on the info card turns green while the device is taking your input. Clicking anywhere in the dashboard outside the device stops it.

## Launch the app {#launch-the-app}

Once the device is up, the build is installed on it automatically. When the install finishes, a **Launch app** button with a play icon appears at the top of the toolbar. Press it to run the app. Use the same button to start the app again after closing it.

## Device buttons {#device-buttons}

| Platform | Buttons |
|---|---|
| iOS | **Home** in the toolbar (<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd>), and the side buttons drawn on the device frame |
| Android | **Home**, **Back**, **Recent Apps**, **Volume Up**, **Volume Down** and **Power** in the toolbar |

On iOS, clicking a side button drawn on the device frame (power, volume and so on) presses it.

## Software keyboard {#software-keyboard}

<Badge type="info" text="iOS only" />

The keyboard button in the toolbar (**Software keyboard**, <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd>) shows or hides the iOS simulator's on-screen keyboard. Use it to check a layout the on-screen keyboard covers. If the device does not answer, a notice says the keyboard stayed where it was.

## Rotate {#rotate}

**Rotate** (<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd>) turns the device. Holding the shortcut down turns it once. iOS simulators and Android emulators turn the device's body clockwise; a real Android device, or an emulator started without gRPC, switches between portrait and landscape.

### Rotate on iOS {#rotate-ios}

<Badge type="info" text="iOS only" />

<a id="rotate-iphone-duo"></a>

An iOS simulator turns a quarter turn clockwise on each press of **Rotate**, so four presses bring it back to where it started and you can check both the left and the right landscape. The frame turns first and the screen follows.

The screen turns with the device, as it does in your hand. An app that supports the new orientation stands its screen back up; one that does not stays on its side.

The device's orientation is shared by everyone looking at it. tapflow does not change it when a session starts or ends, and reloading the page or a teammate joining finds the device where it was left. A flow run is the exception: it starts the device upright, so it replays the same way every time. An iPhone Duo is not stood up yet and starts a run where it was left.

A turn made in Xcode's DeviceHub or Simulator.app shows in tapflow when a session starts and on the next press of **Rotate**. An iPhone Duo shows it within about 6 seconds.

### Rotate on Android {#rotate-android}

<Badge type="info" text="Android only" />

An Android emulator turns like an iOS simulator: each press of **Rotate** turns the device's body a quarter turn clockwise. The device turns first and the screen follows. An app that supports the new orientation stands its screen back up; one that does not stays on its side. A turn made with the rotate buttons of an emulator window you started yourself shows in tapflow too. An emulator started by tapflow runs without a window, so it has none.

tapflow does not change the orientation when a session starts or ends. The exceptions are a boot where tapflow starts the emulator itself and a flow run: those stand the body upright first.

tapflow frees an emulator's rotation lock (auto-rotate off) once per AVD, the first time it sees it, to clear the lock earlier versions of tapflow set. A lock you set after that is left alone.

The dashboard's screenshots and recordings keep the orientation the body is shown in. The MCP server's screenshots follow the screen Android draws, so they can be turned differently.

A real device, and an emulator started without gRPC, still turn between portrait and landscape on each press of **Rotate**. If you leave the session with one of them in landscape, it is turned back to portrait before it shuts down.

## Fold and unfold {#fold}

A foldable Android emulator and the iPhone Duo simulator get a fold button in the toolbar. Each press switches between folded (**Folded**) and unfolded (**Unfolded**), and the button's name is **Unfold** or **Fold** followed by the current posture and the one it will change to. While the posture changes, the button shows a spinner.

### Fold an iPhone Duo {#fold-iphone-duo}

<Badge type="info" text="iOS only" />

An iPhone Duo takes 4–6 seconds to fold or unfold. Meanwhile the device screen shows **Folding...** or **Unfolding...**, and the new screen fades in once it lights. Unfolding opens the device all the way (180°).

A fold made in Xcode's DeviceHub shows in tapflow too. tapflow follows a new screen only once it has stayed lit for 4 seconds, so the change usually shows 4–6 seconds later, and up to about 10 seconds if the device had been left alone for more than 30 seconds. This keeps tapflow from following a screen that lights for a moment while the device starts up.

The iPhone Duo simulator needs Xcode 27.1 or later on an Apple silicon Mac. Its input goes through a helper tapflow runs inside the simulator, and on a Mac that cannot run it the iPhone Duo is either left out of the device list or fails with an error when you pick it.

## Restart the device {#restart}

**Restart the device** opens a confirmation (**Restart this device?**). Press **Restart** and the device shuts down and boots again.

- Anything open on the device closes, and whatever you had set up on screen is gone.
- The build under test is installed again once the device is back, which clears that app's data.
- Other apps and their data stay.

To erase all of the device's data, turn on **Full reset** before picking the device (see [QA Session](/testing/qa-session#select-device)).

## Clipboard {#clipboard}

The clipboard works while your keystrokes are going to the device, after you click its screen.

- **Device to your computer**: select text on the device and press <kbd>⌘</kbd> <kbd>C</kbd> (or <kbd>Ctrl</kbd> <kbd>C</kbd>) to copy it to your computer's clipboard. <kbd>X</kbd> cuts instead.
- **Your computer to the device**: paste text you copied on your computer into a field on the device with <kbd>⌘</kbd> <kbd>V</kbd> (or <kbd>Ctrl</kbd> <kbd>V</kbd>).

If the dashboard is open over plain HTTP, text copied on the device stays on the device and the notice **Copied on the device. Serving the dashboard over HTTPS also brings it to your clipboard.** appears. Browsers allow this kind of clipboard write only on a secure connection (HTTPS or `localhost`). Ask your operator to set up HTTPS.

## Platform support {#platform-support}

| Feature | iOS | Android |
|---|---|---|
| Tap, swipe, pinch, typing | Yes | Yes |
| Device buttons | Home, side buttons on the device frame | Home, Back, Recent Apps, Volume Up, Volume Down, Power |
| Software keyboard button | Yes | No |
| Rotate | A quarter clockwise, all four ways | gRPC emulators a quarter clockwise; real devices and emulators without gRPC portrait and landscape |
| Fold and unfold | iPhone Duo (Xcode 27.1 or later) | Foldable emulators with two postures |
| Restart, clipboard | Yes | Yes |

## Limits {#limits}

- Shortcuts use <kbd>⌘</kbd> (Command). Only the clipboard also accepts <kbd>Ctrl</kbd>.
- Shortcuts do not fire while the cursor is in one of the dashboard's text fields.
- <kbd>⌘</kbd> <kbd>C</kbd> pressed while text is selected in the dashboard is the browser's own copy, not the device's.
- Text pasted into the device is limited to 1 MB. Anything larger shows **That text is too large to send to the device**.

## Troubleshooting {#troubleshooting}

- **Keys do not reach the device.** Click the device screen once and check that **Focus** is green.
- **Text copied on the device is not on your clipboard.** If the dashboard address starts with `http://`, the copy stays on the device, as described under [Clipboard](#clipboard).
- **The device is taking too long — try again** appears. The device did not answer in time; try again.
- **The iPhone Duo is not in the device list.** Check that the operator's Mac has Xcode 27.1 or later. If the agent log has a `not offering` line, the reason is on it.
- **Picking an iPhone Duo fails with `cannot be used on this Mac`.** tapflow's input helper could not be used on this Mac: the simulator refused it, or it was not ready in time. Pass the reason after the message on to the operator.
- **The stream lags, or inputs arrive late.** See [Stream & sessions](/troubleshooting/streaming#stream-lag).

## Related {#related}

- [QA Session](/testing/qa-session): starting a session, the feature list, and keyboard shortcuts
- [Deep links](/testing/deep-links): opening a specific screen of the app from a URL
- [HTTPS (secure context)](/reference/configuration#https-secure-context): the HTTPS setup the clipboard and the Smooth profile need
