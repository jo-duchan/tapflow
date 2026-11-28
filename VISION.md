# Vision

> Why tapflow exists and the direction we hold. For *what* ships and *when*, see [ROADMAP.md](./ROADMAP.md).

tapflow is a mobile QA platform for the whole team. Test by hand in the browser, let an AI agent drive the device, and turn what either of them did into regression runs that replay on every build. Where you start is up to you.

## One Core, three ways to use it

**tapflow Core** is the shared infrastructure on machines you already own, with devices on your team's Macs and the relay beside them: devices, sessions, UI trees, builds, run records, and resource management. It is the name for the layer everything shares, not a separate package, product, or tier. Everything in tapflow is MIT-licensed open source.

Manual QA, AI Agent QA (via MCP), and Automation QA are three ways to use it:

- **Manual QA** (the browser dashboard) — a person tests on a real simulator or emulator.
- **AI Agent QA** (via MCP) — an LLM agent drives a device through the MCP server, in the same session a person can open and watch.
- **Automation QA** (the flow runner) — deterministic flows replayed as regression tests, e.g. `tapflow flow run login.yaml` in CI.

Each is useful alone, and what sets tapflow apart is how they connect: a failed run is a record a person or an agent can read, an agent can author a flow through MCP and replay it, and what a person tests becomes a flow (Flow Capture, below). Those connections are possible because all three share the same session, app, and runtime: an agent's session is the same session on the same device, and a person can open it and watch live. Appium and similar tools start a separate test session with its own driver; tapflow reads the UI tree from the session people and agents already use.

## Philosophy

```text
Start Anywhere  ·  Repeat Without a Model  ·  Always Reviewable
```

- Each way of using tapflow must be worth using on its own. Manual QA alone is a complete product, and so are the flow runner in CI and an agent driving a device through MCP.
- What repeats runs without a model. A regression run replays the same steps every time, with no model choosing them, so a changed result points at the app or the environment, not the tool.
- Nothing an agent or a flow does is a black box: a person can watch an agent's session live, and every flow run leaves a record a person can open and an agent can read.

## Why the connection matters

Most teams don't skip QA automation because they lack AI. **They lack the time to build it.** So the same checks get done again, by hand or by an agent, on every build.

tapflow turns the QA a person or an agent *already did* into automation, so the cost of automating approaches zero:

```text
A person or an agent tests  →  tapflow records it as a flow  →  a deterministic replay confirms it  →  every build after replays it
```

## The moat: Flow Capture (record what was meant, replay it without a model)

The feature we care about most is **Flow Capture**: a person operates the app in the dashboard (or an agent drives it through MCP), and at each action tapflow records *what* was acted on, not where on the screen it was.

Capture picks the sturdiest anchor the screen offers, in this order:

1. **A selector from the UI tree** — an `identifier` or `label`. This is the default, and it is only possible because the session already has a UI tree attached.
2. **A text or image anchor** — where the screen has no usable tree (a game, a canvas, an app that exposes no accessibility information), the text or image region that was acted on. Capture records it with no model; a model may suggest a better one.
3. **A raw coordinate** — the last resort.

The flow records which kind of anchor each step uses, so a person can see which steps depend on copy, appearance, or layout.

Coordinate recording is a common root of flaky tests — it breaks when layout or resolution changes. What other tools do in a separate recorder, tapflow does in the session the team already tests in: at each action it picks the sturdiest anchor while what was meant is still on the screen, writes it down, and replays it without inferring it again. Tools that ask a model on every run cannot promise the same run twice; a flow that names its anchors can. The iOS/Android tree backends are not "a feature for AI to read the screen" — **they are what makes the first, sturdiest anchor possible.**

## Where a model runs, and where it doesn't

- **An agent driving a device uses a model; replay does not.** The flow runner replays the anchors written in the flow, so a regression suite costs no tokens and no model decides what it does. Capture does not need a model either. Where the tree is empty, it records the text or image region under the action; a model may suggest a better anchor, and an anchor a model chose lands in the flow only after a deterministic replay finds it.
- **Moving from agent to flow goes through a gate.** When tapflow saves a flow that an agent or a model produced, it saves it only after a deterministic replay passes. It is the discipline we already use in development (adversarial review, schema-checked outputs), applied to the product.
- **A model can still help outside the run:** naming a scenario, suggesting assertions, tidying steps, or repairing a failed flow from its run record. Whatever it produces passes the same gate.

## Always Reviewable: nothing runs as a black box

An agent driving a device, or a flow failing in CI, should not be a black box that reports pass or fail.
The person who asked an agent to test watches the device it is driving, through the link the agent hands them. A flow run leaves a record
next to its build: the flow, each step's result, the failure, and whether the product or the environment
failed. Those records are kept only as long as the build is.

The same records serve the agent. **We build the tool a person uses to understand a run, then hand that
tool to the agent**. A failure record a person can read is one an agent can read through MCP to repair the
flow, and the repair happens outside the run, so replay stays deterministic. Agent work does not get a separate
dashboard.

## The line we hold

What we grow is how easily work moves between the three, above all from something done once to something every build runs. We do not grow the *count* of automation features. That transition is where tapflow differs most from Appium and traditional test frameworks — and it is worth protecting over any single capability.

Three things are not negotiable:

- **Replay calls no model, not even optionally.** Nothing decides a step or an assertion at run time except the flow as written.
- **tapflow saves agent or model output as a flow only after a deterministic replay passes.**
- **Manual QA and the flow runner never depend on an agent or any model.**

At replay, a matcher may only *locate* what the flow names: a selector, a string, or an image region recorded at capture. It reports only whether and where the named target is; what to act on and what counts as a pass are written in the flow, not decided by the matcher. Anything that interprets the screen beyond locating a named target is a model in this sense, however it is run, seeded, or pinned. On-device text recognition that finds a recorded string is a matcher. A matcher's results can still shift across OS versions; that shift belongs to the environment, and the run record names the matcher's version.

A feature that breaks any of them is out, however useful.
