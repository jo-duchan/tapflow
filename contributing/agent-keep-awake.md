---
type: rationale
topics: [macos, performance, power, android]
status: stable
---

# Why the agent holds a `caffeinate` power assertion during a session

> Read this before removing the sleep blocker from the agent connect/disconnect path.
> Without it, an idle host Mac throttles the emulator down to ~4-5 fps mid-test.

## The problem

When the host Mac goes idle or sleeps, macOS throttles background work, and the software
encoding path of the Android emulator (QEMU) is hit hardest: it drops to about 4-5 fps
while a tester is watching. An unattended, on-battery, or backgrounded Mac triggers this.
`caffeinate -i` was confirmed to resolve it in practice, including with the screen off.

`caffeinate` blocks idle and sleep only. It does not change on-battery CPU scaling or the
cost of software encoding, so this is a partial fix that removes the dominant cause, not a
total one.

## Decisions

- **Session-scoped, not agent-lifetime.** The blocker is acquired when a device connects
  and released on disconnect, so an idle daemon does not keep the Mac awake 24/7. An
  always-on assertion is simpler but was rejected as battery-hostile.
- **Acquire/release on connect/disconnect, not per-device count.** Device state is cleared
  wholesale rather than deleted per device, which makes 0↔1 transition tracking fragile;
  the connect/disconnect scope is more robust and matches the verified manual workaround
  (`caffeinate -i pnpm dev`).
- **No-op off macOS, and no-op under vitest.** Non-darwin platforms do nothing, and tests
  default to a stub so they never spawn a real `caffeinate`. A missing or failed
  `caffeinate` is ignored rather than thrown.
