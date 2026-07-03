---
type: rationale
topics: [android, rotation, scrcpy]
status: stable
---

# Why Android rotation uses `wm user-rotation` and a pinned scrcpy version

> Read this before switching rotation back to `settings put user_rotation`, changing
> scrcpy's `capture_orientation`, or downgrading the bundled scrcpy server. The rotation
> pipeline is correct; the bugs were in the tools it drives.

## The two fixes that make rotation work

Rotatable apps were captured in portrait and, combined with the viewer's fixed CSS
rotation, appeared lying on their side. Two independent causes:

1. **The rotation command.** The legacy `settings put user_rotation` is ignored on API 35+,
   so the display never rotated. `AdbWrapper.setRotation` uses `wm user-rotation lock <r>`
   instead, which is the API 31+ standard and works across the supported range.
2. **The scrcpy version.** scrcpy 3.1 had a locked-capture-orientation bug (scrcpy #6010)
   that captured API 35+ content reversed, fighting the fixed CSS rotation. The bundled
   server is pinned to 3.3, which fixes it. Protocol compatibility was checked first:
   option and header offsets match 3.1, so the video parser needed no change.

## Why not change the capture orientation instead

The pipeline design is deliberate and correct: scrcpy captures portrait-locked
(`capture_orientation=@0`) and the frontend applies a CSS rotate. The WASM decoder pins
its SPS, so changing `capture_orientation` at runtime is not an option. Bumping the scrcpy
version was the fix, not reworking the pipeline. Verified after the change: rotation
correct on API 36, no regression on API 34.
