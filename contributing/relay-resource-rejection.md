---
type: rationale
topics: [relay, resource-management, session]
status: stable
---

# Why the relay rejects new sessions when an agent is overloaded

> Read this before removing the CPU/RAM gate on `session:start`, or before moving the
> decision into the agent. An overloaded Mac silently degrades every existing session.

## The problem

When another session attaches to an already-overloaded Mac, the streaming quality of the
QA sessions already running on it drops. Origin: [#107](https://github.com/jo-duchan/tapflow/issues/107).

## Decisions

- **The relay decides, the agent does not change.** The agent already reports `agent:resources`
  every few seconds. The relay evaluates that data and rejects a new `session:start` with a
  clear client error when CPU or RAM is over the threshold (default 80%). No agent-side code
  is touched.
- **Fail open.** If there is no resource data, the session is allowed. A stale-data check is
  unnecessary: the agent reports every ~5 seconds and a dropped connection tears the session
  down anyway.
- **Reject, do not queue.** There is no waiting queue and no auto-resume when resources
  recover; the client retries. A single global threshold is used, not per-machine tuning.
- The error message is returned to the client; surfacing it in the dashboard UI is a
  separate concern. This gate is distinct from any slot-count mechanism, which follows its
  own path.
