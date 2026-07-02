---
type: rationale
topics: [relay, builds, storage]
status: stable
---

# Why a build's review status is decoupled from its deletion lifetime

> Read this before wiring build deletion back to `completed_at`, or before treating "Done"
> as a deletion trigger. The two axes are orthogonal on purpose.

## The problem

A build's review workflow (`status_label`) and its storage-deletion countdown were both
driven by a single `completed_at` timestamp. Marking a build `Done` set `completed_at`,
and the purge deleted anything whose `completed_at` was older than the TTL. So "mark as
Done" silently meant "schedule for deletion" — a user could not keep an artifact while
also marking its review complete. Origin: [#258](https://github.com/jo-duchan/tapflow/issues/258).

## The decision

Split the two axes. `Done` becomes a pure completion marker, and deletion runs off a
separate, explicit `delete_after` timestamp. A user can now mark a build complete and still
retain the artifact.

- **Manual triggers only.** No status change auto-schedules or auto-cancels deletion (for
  example, `Rejected` does not auto-expire). The purge still runs at boot and every 24h, and
  the default TTL is unchanged.
- **`completed_at` stays for information.** Its column and index are left in place, unused by
  the purge; an unused index is harmless, and removing it is not worth a migration.
