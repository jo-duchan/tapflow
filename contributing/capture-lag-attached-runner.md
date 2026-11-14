---
type: diagnosis
topics: [performance, ios, flow-capture, measurement]
status: stable
related: [agent-event-loop-blocking, measurement]
---

# Why a person's iOS device has no XCUITest runner attached

> Read this before a feature that runs beside a person's Manual QA session starts anything resident on the device:
> a test runner, an accessibility client, a poll.

## The symptom

With **Capture my steps** on, Food Truck (iOS 26.5) stuttered while scrolling, and the frame rate was visibly lower.
Turned off, it was smooth. Nothing failed, and every test was green: the feature did what it was built to do.

## What it was

The agent warmed the XCUITest runner at every recorded boot so Flow Capture could read the soft keyboard and the
focused field after a person's inputs. Two costs, measured separately:

- **Attached and idle, the runner made the app lag.** No query was running. Killing the runner made the same app
  smooth again, and turning app accessibility on alone (`ApplicationAccessibilityEnabled`, no runner) cost nothing.
- **Each query held the app's main thread 70–155 ms** while XCTest snapshotted it.

Fewer queries (skipping reads after a scroll) was built first and shelved. It cut the second cost and left the first,
which is the one a person feels. The fix was to stop attaching: the reads now come from inside the app, at 3–4 ms and
with no accessibility client (ios-agent AGENTS.md, "App observer").

## The lesson

- **Manual QA is the path everything else rides on.** A feature on by default in a person's session is measured on
  that path, on and off, on a busy app, before it ships. Unit tests cannot see a frame rate.
- **Measure the cost of being attached apart from the cost of each call.** The two need different fixes, and fixing
  the cheaper-to-see one first hides the other.
- **Cut variables one at a time.** Accessibility alone, runner alone, queries alone: the guesses here (the reads
  after scrolls, accessibility itself) were each wrong, and each was ruled out by one A/B.
