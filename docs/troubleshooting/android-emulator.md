---
title: Android emulator
description: An emulator stream that does not start, colors that look less saturated than the emulator window, and an emulator that slows down when the Mac is unattended.
---

# Android emulator

Fixes for Android emulator stream, color and speed problems.

## Stream does not start or encoder crashes

Most often the AVD uses an untested `google_apis_playstore` image. Recreate the AVD with the tested `google_apis/arm64-v8a` image:

```sh
sdkmanager "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n Pixel_8 -k "system-images;android-35;google_apis;arm64-v8a"
```

## Colors look different from the emulator (less saturated)

Colors in tapflow may look slightly less saturated than the Android emulator window. **This is expected — and tapflow is actually the more faithful reference.**

- **tapflow** renders the pixel values from the agent's H.264 stream as-is, so it stays close to your design source (Figma, etc.).
- **The emulator window** runs the image through an extra display color-processing step when drawing to the screen, which boosts saturation above the source.

For reviewing design colors, **tapflow is the more trustworthy reference**.

::: details Measured example
Measuring a flat solid orange swatch with a color picker:

| Source (Figma) | tapflow | Emulator |
|----------------|---------|----------|
| `#FF8000` (G=128) | `#FF7700` (G=119) | `#FF6C00` (G=108) |

tapflow (G=119) stays closer to the source (G=128), while the emulator (G=108) drifts further from it, rendering a more saturated orange.

Black (`#000000`), white (`#FFFFFF`), and pure R/G/B are identical across all three — the difference appears only in midtone saturation, not from a corrupted stream.
:::

## Emulator is slow when the Mac is unattended

tapflow automatically prevents the host Mac from idle-sleeping while the agent is running (`caffeinate -di`, or `caffeinate -i` when `TAPFLOW_ALLOW_DISPLAY_SLEEP` is set). The assertion is acquired when the agent connects and released when it exits.

If the emulator is still slow when the Mac is unattended, check the following.

| Check | Why it matters |
|-------|----------------|
| **Power adapter connected** | Battery mode lowers CPU performance — `caffeinate` does not override this scaling. |
| **Laptop lid is open** | Closing the lid triggers clamshell sleep, which `caffeinate` cannot prevent. |
