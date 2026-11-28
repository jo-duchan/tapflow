---
title: Deep links
description: "Open a specific screen of the app on the QA Session device from a URL, through the toolbar button or ⌘K."
---

# Deep links

A deep link is a URL that opens a specific screen of an app, such as `myapp://settings`. Enter one in a QA Session and you land on the screen you want to check instead of tapping your way there from the first screen. There is nothing to turn on.

<!-- Video slot: once the clip is in docs/public/media/, replace this comment with <VideoPlayer src="/media/FILE.mp4" poster="/media/FILE.png" />. -->

## How to use {#how-to-use}

1. On a device with the app installed, press the link icon in the toolbar (tooltip **Deeplink**, accessible name **Open a deeplink**), or press <kbd>⌘</kbd> <kbd>K</kbd>.
2. Type the URL into the box (**Deeplink URL**).
3. Press <kbd>Enter</kbd> or **Open**.

When the device opens the URL, a **Deeplink opened** notice appears. If it fails, the notice shows the error message the device sent back. The box is empty each time it opens.

## Platform support {#platform-support}

| | iOS | Android |
|---|---|---|
| Supported | Yes | Yes |
| How the URL is opened | Asks the simulator to open the URL (`simctl openurl`) | Sends the emulator a view intent for the URL (`am start -a android.intent.action.VIEW`) |

On both platforms the device picks the app that handles the URL, as it would for a link tapped on a phone.

## Limits {#limits}

- The app that handles the URL must be installed on the device and must have registered its URL scheme. [Launch the app](/testing/device-controls#launch-the-app) first to be sure the install has finished.
- <kbd>⌘</kbd> <kbd>K</kbd> does not fire while the cursor is in another of the dashboard's text fields.

## Troubleshooting {#troubleshooting}

- **The notice appeared but the screen you wanted did not open.** The app is what reads the URL. Check with its developers that it handles that path. On Android, **Deeplink opened** can also appear when no app on the device registered the URL scheme.
- **A `no booted device` or `No booted device` error appears.** The device is still booting, or the session has dropped. Try again once the progress message on the info card is gone.
- **The session keeps dropping.** See [Stream & sessions](/troubleshooting/streaming).

## Related {#related}

- [QA Session](/testing/qa-session): everything a session offers, and keyboard shortcuts
- [Device controls](/testing/device-controls): launching the app and device buttons
