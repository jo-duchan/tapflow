# Vision

> Why tapflow exists and the direction we hold. For *what* ships and *when*, see [ROADMAP.md](./ROADMAP.md).

tapflow is not an automation tool. It is a **mobile QA platform that grows manual QA into automation, naturally, only when you need it.** Automation is not the center — the **QA workflow** is, and AI is what connects its parts.

## Three axes, one workflow

tapflow looks like three features, but they are one workflow used from different starting points:

- **Manual QA** (the browser dashboard) — the starting point, and a complete product on its own.
- **AI Automation** (the flow runner + MCP server) — valuable independently, e.g. `tapflow flow run login.yaml` in CI, or an LLM agent driving a device.
- **Manual ↔ AI bridge** — the real differentiator.

They are not competing features. All three share the **same session, the same app, the same runtime**. That is the technical reason a "Save as Flow" moment feels natural — the dashboard session *is* the MCP session on the *same* simulator. Appium and friends stand up a separate driver first; tapflow does not.

## Philosophy

```text
Manual First  →  Automation When Needed  →  AI Assists  →  Always Reviewable
```

- Manual QA must be a 100-point experience on its own.
- Automation must be usable independently.
- AI connects the two — it is not the center.

## The core differentiator

Most teams don't skip QA automation because they lack AI. **They lack the time to build it.** So they test by hand, then test by hand again, every build.

tapflow turns the QA a person *already did* into automation, so the cost of automating approaches zero:

```text
A person tests  →  tapflow captures it  →  every build after runs it
```

## The moat: Flow Capture (selector-based, not coordinate-based)

The feature we care about most is not the flow runner — it is **Flow Capture**: a person operates the app in the dashboard, and at each tap tapflow reads the accessibility tree and records the action as an `identifier`/`label` **selector**, not a raw coordinate.

This distinction is the moat. Coordinate recording (what Maestro/Appium record produce) is the root of flaky tests — it breaks when layout or resolution changes. Selector capture is robust, and it is only possible because the session already has a UI tree attached. The iOS/Android tree backends are not "a feature for AI to read the screen" — **they are the foundation of Flow Capture.**

## Where AI fits: additive, and wrapped in a harness

- **Capture itself is deterministic (AI-free) and must be useful without AI.** If AI were required, its cost, latency, and non-determinism would just become the new barrier — the very thing we set out to remove.
- **AI adds value on top**: naming a scenario, suggesting assertions, tidying redundant steps.
- **AI output is wrapped in a harness.** A generated flow is immediately verified by a deterministic replay — it only lands if it passes. This buys efficiency (AI drafts fast) *and* idempotency (the replay gate pins it down). It is the same discipline we already use in development (adversarial review, schema-checked outputs), brought into the product.

## The line we hold

Grow the *naturalness* of the manual-QA → automation transition, not the *count* of automation features. That transition is where tapflow differs most from Appium and traditional test frameworks — and it is worth protecting over any single capability.
