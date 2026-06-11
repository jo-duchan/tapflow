---
"@tapflowio/ios-agent": minor
---

iOS: auto-recover a simulator whose data directory vanished from disk. When an Xcode/macOS update prunes a runtime, `boot` fails with "cannot be located on disk"; the agent now erases the device to regenerate its data and retries the boot once (guarded so a healthy device is never erased), so dashboard/MCP sessions no longer dead-end on a broken simulator.

Pre-boot is removed: `tapflow start` no longer boots a guessed device on startup. The agent only registers devices and boots on demand via `device:boot` (parity with android-agent). As a result, `--device` is now a relay-exposure filter (which simulators are exposed, default: all), not a boot target.
