---
title: QA Session
description: "The full-screen device view: pick a Mac and a device to start a session, then touch, swipe, open deep links, record, and comment on the build."
---

# QA Session

**Route**: `/app-center/build`

The full-screen device view. Opened when you click a build row in App Center. Pick a Mac under **Select Mac**, then click a device under **Select device** to start a session. The device list shows each device as **Booted**, **Available**, or **In use** (another teammate has it). Use the breadcrumb at the top to go back a step.

| Control | Description |
|---|---|
| Touch | Click or tap anywhere on the simulator to send a touch event. |
| Swipe | Click and drag to swipe. |
| Pinch | Hold Option (Alt) and drag. |
| Device buttons | The toolbar buttons differ by platform. iOS has **Home** and a software keyboard button; Android has **Home**, **Back**, **Recent Apps**, and volume and power buttons. |
| Deep link | Enter a deep link URL to open a specific screen in the app directly. |
| Start / Stop recording | Start and stop recording from the toolbar. Recordings collect per build in the **Recordings** tab and can be downloaded. |
| Comments | Leave threaded comments on the build in the **Comments** tab. You can attach images, and comments are visible to the whole team. |

The screen streams at ~30 fps. Frame rate adapts to your network automatically.

::: info Recording retention
Recordings are kept for **72 hours** after creation. Download them before they expire if you need them long-term.
:::
