---
type: reference
topics: [performance, capacity, extensibility, external-fork]
status: stable
related: [measurement, runtime-platform-registration]
---

# Field observations from the workshop-lab fork (third-party)

> Two things worth keeping from an external fork that built a workshop seat-leasing
> layer on top of tapflow: an **independent capacity data point** for concurrent
> iOS simulators, and a **signal about where our extension seams stop**. This is a
> curated read of someone else's work, not a decision record — read it for the
> evidence, not for a mandate to build anything.

## Source

Raghu Betina (First Draft) forked tapflow to lend iOS Simulators to workshop
attendees who lack a Mac, adding authenticated per-attendee "seat" leasing with
destructive cleanup between users. Field report and code:

- Fork: <https://github.com/raghubetina/tapflow-workshop-lab>
- Snapshot commit: [`3945d74`](https://github.com/raghubetina/tapflow-workshop-lab/commit/3945d748555e3ffe1262b66e3fd022385ccf9e81) (a single squashed "Preserve workshop simulator seat experiment" commit, taken against upstream `10aa531`)
- Report: `FIRST_DRAFT_WORKSHOP_LAB_EXPERIMENT.md` in that repo

The fork keeps tapflow's MIT license and its `Copyright (c) 2026 tapflow contributors`
line, so the numbers and findings below are cited freely, with attribution as a
courtesy. The measurements are *facts* (not copyrightable); the prose here is our
own paraphrase, not a copy of the report.

## Capacity data point — concurrent iOS simulators

Measured by the fork author on a single **32 GB M1 Max** host (Xcode 26.6), running
prewarmed simulators as workshop seats. Paraphrased from their report:

| Prewarmed sims | Verdict |
|---|---|
| **4** | Comfortable. Repeated route/stream checks and a ~5-minute active soak held up. |
| **6** | Functional but borderline — only defensible as facilitator-controlled overflow. |
| **8** | Not acceptable: latency, frame loss, CPU pressure, and swap all too high. |

Their practical ceiling: **~4 learner seats per 32 GB M1 Max**.

**Why it's worth keeping:** we have no independent (non-self-run) measurement of how
many prewarmed simulators one Mac holds before it degrades. The shape also matches
our own model — the drop from *comfortable* (4) to *unacceptable* (8) is a cliff, not
a gradual slope, consistent with a memory/swap saturation point rather than linear
CPU cost. It corroborates the assumption behind the relay's boot-time resource gate
(see [`relay-resource-rejection.md`](./relay-resource-rejection.md)).

**Caveats — this is directional, not a benchmark suite.** One host config, iOS
Simulator only, a short (~5-min) soak, and a single fixed native build per pool. Do
not quote it as a tapflow-verified figure; it is one third party's field reading.

## Extension-seam signal — the seat layer had to modify core

The seat pool is not a new *platform*, so [`AgentRegistry.register()`](./runtime-platform-registration.md)
— our one clean OCP extension seam — does not cover it. That seam is scoped to
platforms; there is no equivalent seam for **session-lifecycle / multi-tenant
features** (leasing, per-lease access scoping, destructive reset-and-return).

The fork's snapshot bears this out: it is not a registry add-on but a broad edit of
the core. Modifications against upstream `10aa531` include:

- `packages/relay/src/RelayServer.ts` (+1161 / −40)
- `packages/relay/src/SessionManager.ts` (+97 / −1)
- `packages/relay/src/api/auth.ts`, `api/invitations.ts`, `api/team.ts`, `middleware/auth.ts`
- `packages/ios-agent/src/IOSAgent.ts` (+243 / −30), `SimctlWrapper.ts` (+83 / −21)
- CLI entrypoints `commands/start.ts`, `relay-start.ts`, `init.ts`

**What this tells us (open question, not a plan):** if session lifecycle / pooled
ephemeral sessions ever move onto the roadmap, they would today require touching
`RelayServer` and `SessionManager` directly, the same way this fork did. That is a
seam we have not designed. Worth noting *where* it hurts before deciding whether it
is worth a seam at all. We do **not** take the seat-pool feature itself: pooled
multi-tenant leasing is outside tapflow's manual-first, trusted-team scope, and
adding unrequested features is against our roadmap discipline.

## What we deliberately do not take from the report

- **The seat-pool feature** — a specialized fork layer, correctly a fork, not upstream.
- **The security finding** as an action item. The report warns that a simulator uses
  the host's network stack, so an attendee can pivot from the workshop app to Safari
  and reach host-local / private-LAN services that app-level auth does not contain.
  That is real, but it is a *containment* concern that only bites when the actor is
  **untrusted**. tapflow's model is a trusted team on a LAN, gated twice (LAN
  reachability + id/pw), where a logged-in teammate already has that LAN access
  anyway — so there is nothing new to contain. The lesson only re-activates if we
  expose tapflow to untrusted actors over a public tunnel, at which point the LAN
  gate is gone and id/pw is the only gate left. A one-line note belongs in the
  eventual public-exposure / HTTPS-tunnel docs, not in the code.

## Related

- [`measurement.md`](./measurement.md) — our own instrumentation surface for capacity/latency numbers.
- [`runtime-platform-registration.md`](./runtime-platform-registration.md) — the platform extension seam this fork fell outside of.
- [`relay-resource-rejection.md`](./relay-resource-rejection.md) — the boot-time CPU/RAM gate the capacity cliff corroborates.
