---
component: TechLabel
source: components/ui/tech-label.tsx
cva: none
own: tone
---

# TechLabel

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to TechLabel.

`components/ui/tech-label.tsx` is a `span` with one class string and no `cva`. It sets the face and the figures for
a technical value — a build number, a bundle ID, a duration, a commit. `tone` below is the color it ends up in,
which comes from the call site, not a prop.

## Anatomy

```
build 42        Took 1m 05s        com.example.coffee
      ──               ─────       ──────────────────
      TechLabel        TechLabel   TechLabel
```

- **Face** — JetBrains Mono (`font-mono`), 12px (`text-xs`) on a 16px line, weight inherited (regular unless the
  parent sets one).
- **Figures** — every glyph of a mono face is the same width, so a counting duration or a column of numbers does
  not jitter. `tabular-nums` is also set; it changes nothing with JetBrains Mono and matters only if a fallback
  font loads.
- **Tracking** — `tracking-tight` (−0.025em). Mono is wide; this pulls it in so it sits beside Inter.
- **Color** — none of its own. It takes its parent's color unless the call site sets one (`tone` below).
- **Inline.** No padding, no background, no border. It is text, not a chip; for a value in a box use `Badge`.

It has no states: it is not interactive.

## Properties

### `tone`

| Value | Looks like | Call sites | Where |
|-------|------------|-----------:|-------|
| `inherit` | The parent's color | 8 | `--foreground`: Runs table (flows passed, duration), the build row's number, the release header's version (which sets `text-foreground` on the label itself, the same color). `--muted-foreground` from the parent: the build row's upload date, the run header's commit, duration and exit code |
| `muted` | `--muted-foreground` set on the label (`text-muted-foreground`) | 6 | Flow and step durations and the flow file on a run's page, the video's size and clock, an app's bundle ID in the App Center sidebar |

Call-site counts are a snapshot (2026-10-18). On screen most TechLabels are muted: 4 of the 8 `inherit` sites sit
in a muted line.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Release header (App Center) | `font-medium text-sm text-foreground` | The version is the header's title: 14px medium, not 12px |
| Build row number | none, inside `text-sm font-medium` | `build` is 14px Inter and the number beside it 12px mono, both medium. Draw the size step; it is what ships |
| App Center sidebar, selected app | none, inside `font-medium` | The bundle ID turns medium with the selected row |
| App Center sidebar bundle ID | `truncate` | Long IDs end in an ellipsis in the 256px sidebar |
| Run page flow file | `block` | Its own line under the flow name |

## Mono text that is not TechLabel

These set `font-mono` by hand, without `tracking-tight`, so they run slightly wider than a TechLabel of the same
size. The first two are values DESIGN.md says belong in TechLabel (a bundle ID, a version string): that is drift in
the code, not a second style, so draw them as TechLabel. The rest are not technical values.

| Where | Classes |
|-------|---------|
| Settings → Default, Apps card, bundle ID | `font-mono text-xs text-muted-foreground` |
| QA session device list, OS version | `font-mono text-xs text-muted-foreground` |
| Device info card, fps | `font-mono text-[12px] text-foreground/75` |
| App Center and Macs sidebar headings | `font-mono text-xs font-medium uppercase tracking-wider`, `--muted-foreground` — a heading style, not a value |
| Read-only copy fields | `Input` with `font-mono`, 14px from 768px up — see [input.md](./input.md) |

## Usage

- Wrap a value a person might compare, copy or read back character by character in TechLabel: build numbers,
  version names, bundle IDs, commits, durations, counts in a table.
- Leave the words around it in Inter: `build <TechLabel>42</TechLabel>`, `Took <TechLabel>1m 05s</TechLabel>`.
- Set the color on the label only when the parent is a different color; otherwise let it inherit.
- Do not use it for prose or for names people chose (an app name, a flow name). The release header is the one
  place it carries a title, because that title is a version string.

## Figma

Component set **TechLabel** (`1:2652`) on the `Data display` page of tapflow-design-system — `tone` × 2. The names
match this spec.
