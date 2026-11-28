---
title: Screenshots & recordings
description: "Download the QA Session device screen as a PNG, or record it as a video. Recordings stay in the build's Recordings tab for 72 hours for any teammate to download."
---

# Screenshots & recordings

Keep what you saw in a [QA Session](/testing/qa-session) as an image or a video, for a bug report or a [comment](/testing/comments). Both are in the toolbar's Capture group, and there is nothing to turn on.

## Screenshots {#screenshots}

Press the camera button in the toolbar (**Screenshot**) or <kbd>⌘</kbd> <kbd>S</kbd> and the current device screen downloads as `tapflow-<timestamp>.png`. Your browser saves the file straight to your computer; it is never uploaded to the tapflow server (the relay).

## Recordings {#recordings}

1. Press the record button in the toolbar (**Start recording**) or <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>Y</kbd>. The button turns red while recording.
2. Press it again (**Stop recording**) to stop, and the video is saved to the relay. The button shows a spinner while it saves.
3. When saving finishes, the video also downloads to your computer automatically.

Recordings collect in the build's **Recordings** tab. Open the **Recordings** tab under the info card to see each recording's time, how long it is kept for (such as **Expires in 2d**), and its size, and download it with the **Download** button. Every teammate who opens the same build sees this list.

A recording is saved the way the device is shown: start one with the device turned to landscape and the video is landscape too. Turning or folding the device during a recording keeps the video at the size it started with, and the device is fitted inside it.

The video format depends on your browser: `.mp4` where the browser can record MP4 (H.264), `.webm` otherwise.

## Platform support {#platform-support}

| | iOS | Android |
|---|---|---|
| Screenshots | Yes | Yes |
| Recordings | Yes | Yes |

## Limits {#limits}

- Recordings are kept for 72 hours after they are made. An expired recording leaves the list, and the relay deletes the files once a day. Download anything you want to keep.
- Switching to another browser tab or minimising the window while recording stops the recording and saves it.
- A recording holds the device screen only, not the device's sound.
- Screenshots are not shared with the team automatically. To share one, attach it to a [comment](/testing/comments).

## Troubleshooting {#troubleshooting}

- **A recording is missing from the Recordings tab.** You may have left the page while it was saving, or the save failed. Check the list again after the record button is back to normal.
- **Couldn't load recordings.** means the list could not be fetched. Reload the page.

## Related {#related}

- [QA Session](/testing/qa-session): everything a session offers, and keyboard shortcuts
- [Comments](/testing/comments): attaching a screenshot to share it with the team
