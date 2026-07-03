---
type: rationale
topics: [ios, lifecycle, recovery]
status: stable
---

# Why `tapflow start` does not pre-boot an iOS simulator

> Read this before re-adding a boot step to iOS startup, or before letting automatic
> recovery `delete` a device. Startup boots nothing on purpose, and recovery only touches
> devices that are provably dead.

## The problem

`tapflow start` used to pick an iOS simulator and boot it at startup as a warm-up
convenience. When that device was a broken or zombie shell, the boot hung and startup
itself stalled. The warm-up had a low hit rate and Android never had it.

## Decisions

- **No pre-boot.** iOS startup now only `connect`s, like Android, and boots no device. With
  nothing booted at startup, there is no zombie to boot, so the "startup stalls" failure
  disappears at the source. The dashboard and the MCP/CI paths never depended on pre-boot;
  they each pick a device and boot it explicitly.
- **Recovery lives at the user's boot moment** (`handleDeviceBoot`), the path that runs when
  someone selects a device in the dashboard. If that specific device turns out dead while
  booting, recovery runs there.
- **Recovery prefers `erase` over `delete`.** The user chose a UDID, so recovery
  regenerates data under the same UDID with `erase`. `delete` + recreate would change the
  UDID and break the user's selection context, so it is not the default on this path.
- **Only provably dead devices are erased.** The guard fires only on `isAvailable: false`
  (no runtime) or a boot-time `cannot be located on disk` / `data is no longer present`
  signature. A bootable, healthy device is never erased or deleted.
- **`--device` is a registry-exposure filter, not a boot target.** This aligns iOS with the
  Android convention: the flag narrows which devices are exposed to the relay, useful for
  MCP/CI, rather than choosing what to boot. Keeping the flag means no breaking change.
