---
title: Device controls
description: "Driving the device in a QA Session with mouse and keyboard: touch and gestures, typing, launching the app, device buttons, the software keyboard, rotation, folding, restarting, and the clipboard."
---

# Device controls

<Badge type="info" text="iOS" /> <Badge type="info" text="Android" />

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
| iOS | **Home** in the toolbar (<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>U</kbd>), **Volume Up**, **Volume Down**, **Sleep/Wake** and **Action** (on devices that have it) in the toolbar's **More device buttons** menu, and the side buttons drawn on the device frame |
| Android | **Home**, **Back** and **Recent Apps** in the toolbar, and **Volume Up**, **Volume Down** and **Power** in its **More device buttons** menu |

Hardware buttons such as volume and power are in the menu that the toolbar's three-dot button (**More device buttons**) opens. Volume keeps the menu open after you press it, so you can press it several times in a row. From the keyboard, Tab to the button, press Enter to open the menu, choose with the arrow keys, and press Enter.

On iOS you can also click a side button drawn on the device frame. To hold a button down, keep the frame button pressed. On an iPad turned to landscape, the volume buttons are named by what they do, because iPadOS raises the volume with whichever button is on the right or on top as the iPad is held.

## Software keyboard {#software-keyboard}

<Badge type="info" text="iOS" />

The keyboard button in the toolbar (**Software keyboard**, <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>K</kbd>) shows or hides the iOS simulator's on-screen keyboard. Use it to check a layout the on-screen keyboard covers. If the device does not answer, a notice says the keyboard stayed where it was.

## Rotate {#rotate}

Each press of **Rotate** (<kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd>) turns the device between portrait and landscape. If you leave the session in landscape, the device is turned back to portrait before it shuts down.

## Fold and unfold {#fold}

<Badge type="info" text="Android" />

A foldable Android emulator gets a fold button in the toolbar. Each press switches between folded and unfolded, and the button's name is **Unfold** or **Fold** followed by the current posture and the one it will change to. While the posture changes, the button shows a spinner.

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
| Device buttons | Home, volume, Sleep/Wake, Action (on devices that have it), side buttons on the device frame | Home, Back, Recent Apps, volume, Power |
| Software keyboard button | Yes | No |
| Rotate | Yes | Yes |
| Fold and unfold | No | Foldable emulators with two postures |
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
- **The stream lags, or inputs arrive late.** See [Stream & sessions](/troubleshooting/streaming#stream-lag).

## Related {#related}

- [QA Session](/testing/qa-session): starting a session, the feature list, and keyboard shortcuts
- [Deep links](/testing/deep-links): opening a specific screen of the app from a URL
- [HTTPS (secure context)](/reference/configuration#https-secure-context): the HTTPS setup the clipboard and the Smooth profile need
