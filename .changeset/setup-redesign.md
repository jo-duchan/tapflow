---
"tapflow": minor
---

feat(cli): setup completes in one run; doctor reflects on-demand boot

`tapflow setup` is now an end-to-end interactive wizard instead of stopping to print manual commands:

- runs sudo steps directly after confirmation (`xcode-select -s`, `xcodebuild -license accept`, `-runFirstLaunch`) — no more "run this and re-run setup" loop.
- iOS: downloads the simulator runtime when no device exists.
- Android: when no AVD exists, installs a `google_apis` system image once and creates a set of 4 AVDs across form factors (compact / phone / large / tablet) so the device list is comparable to iOS. Device ids are chosen per-environment from candidates; ABI matches the host arch.
- no longer boots devices — relay boots on-demand when a QA Session connects, so setup only ensures a bootable device/AVD exists.
- `tapflow setup` (no argument) offers to set up Android even when adb isn't found, and ends with a `SETUP COMPLETE` / `SETUP INCOMPLETE` summary banner (per-platform ready state).

`tapflow doctor` now passes when a simulator device or AVD *exists* (any state) rather than requiring a *running* one, matching the on-demand boot model.
