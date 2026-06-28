# Audio

tapflow streams the device's audio to the browser alongside video, so your whole team hears the app — not just sees it. App sound, web audio (e.g. a video playing in the in-app browser), and system sounds all come through.

## On by default

Audio is **on by default** on both iOS and Android. When a viewer opens a device in the browser, its audio plays in that browser tab.

Opt out per agent with an environment variable:

```bash
TAPFLOW_AUDIO=off tapflow agent start
```

That disables audio capture on both platforms; the video path is unchanged either way.

## Requirements

- **iOS** — macOS 14.2+ on the agent Mac (Core Audio process taps). Below that, iOS audio is unavailable; video is unaffected.
- **Android** — captured through the emulator's stream; no extra requirement.

## Permission (one-time)

Both iOS audio capture and the Android host-mute below use a macOS audio-recording permission, so the first time it's needed macOS shows a one-time prompt.

`tapflow agent start` (and `tapflow setup ios`) request it up front, so an unattended operator can grant it while present instead of missing it at first boot. **If browser audio is silent, re-run `tapflow agent start`** — the prompt appears again.

::: tip
The agent operator (whoever runs the Mac), not the dashboard viewer, grants this permission.
:::

## The agent Mac stays quiet

When audio is on, the device's sound plays **only in the browser** — the agent Mac's own speakers stay silent, so there's no echo or noise on a shared or unattended Mac:

- **iOS** — the audio is muted at the capture source.
- **Android** (macOS 14.2+) — a mute-only tap silences the emulator's host output. Below macOS 14.2 the emulator is audible on the agent Mac; lower the Mac's volume.

Other apps on the agent Mac are unaffected.

## Volume

The device's own volume is reflected in what the browser hears — change the simulator/emulator volume and the streamed audio follows.

## Troubleshooting

**No audio in the browser**

- Re-run `tapflow agent start` to re-trigger the permission prompt, then click Allow.
- iOS: confirm the agent Mac is on macOS 14.2 or later.
- Confirm `TAPFLOW_AUDIO` isn't set to `off`.

**The agent Mac plays the emulator's sound (Android)**

- Expected below macOS 14.2 — lower the Mac's volume. On macOS 14.2+ it's muted automatically.

See also: [Streaming Quality](/guide/streaming).
