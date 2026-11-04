---
component: TabsTrigger
source: components/ui/tabs.tsx
cva: none
own: state
---

# TabsTrigger

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to TabsTrigger.

`components/ui/tabs.tsx` wraps Radix Tabs and has no `cva`. This spec covers the trigger and the `TabsList` it
sits in; `state` below is what renders, not a prop. The dashboard uses one look: a segmented control, a muted
track with the active tab raised on it.

## Anatomy

```
TabsList — 36px high, --muted track, 4px padding
┌──────────────────────────────────────┐
│ ┌────────┐                           │
│ │  All   │   CI       Local          │   active: --background, shadow-sm
│ └────────┘                           │   others: no fill, --muted-foreground
└──────────────────────────────────────┘
```

- **List** — `inline-flex`, 36px high (`h-9`), `rounded-md` (6px), `--muted` fill, 4px padding (`p-1`),
  `--muted-foreground` text. As wide as its tabs unless the call site stretches it. Tabs sit edge to edge, with no
  gap and no divider between them.
- **Trigger** — 28px high: `text-sm` (14px) `font-medium` on a 20px line, 4px top and bottom, 12px sides
  (`px-3 py-1`). `rounded-sm` (4px). One line, never wraps.
- **Panel** (`TabsContent`) — 8px under the list (`mt-2`) by default. Only one call site has panels (below).

## Properties

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | No fill, `--muted-foreground` text — the track shows through | 3 |
| `active` | `--background` fill, `--foreground` text, Tailwind `shadow-sm` | 3 |
| `focus` | Shared ring with a 2px `--background` offset (DESIGN.md), on keyboard focus only (`focus-visible:`) | 3 |
| `disabled` | 50% opacity, no pointer events | 0 — defined, no call site disables a tab |

- **No `hover`.** An inactive tab does not change under the pointer.
- **Dark mode turns the active tab darker than the track.** `--background` (9%) on `--muted` (15%): the raised tab
  is a darker inset, not a lighter one. Draw both themes.
- **Pressed moves it 1px.** A trigger is a `<button role="tab">` with no `aria-haspopup`, so the global press motion
  applies (DESIGN.md). That rule also replaces the trigger's own `transition-all`: color and fill change over 120ms,
  and the shadow appears at once.
- The focus ring's 2px offset is `--background`: on the light track (98% on 96%) it barely shows, and in dark mode it
  is a dark band between the tab and the ring. Draw both. The ring reaches 4px outside the tab, so it fills the list's
  height and runs under its neighbours; next to the active tab, that side of the ring is hidden by the active fill.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| QA session side panel — Comments / Recordings | List `w-full`, each trigger `flex-1 gap-1.5` with a 14px icon before the label; panels 12px under the list (`mt-3`) | Two equal halves of a 312px list, inset 4px (`px-1`) inside the 320px panel |
| Flow Runs — All / CI / Local | None. No panels: the tabs filter the list below | A source filter in the toolbar, beside 32px controls (the status Select and the search box) |
| Mac resources — 1h / 6h / 24h / 7d | None. No panels: the tabs set the chart's range | A range picker beside the Mac's name. The list has no name, so a screen reader hears "1h" with nothing saying it is a time range (tracked in #979) |

Two of the three are filters, not tabs over panels. They look and behave the same; Radix still gives them
`role="tab"` and arrow-key movement.

The Flow Runs list sits 36px high beside 32px controls (`h-8`); the heights are not matched.

## Usage

- Use it for two to four short, mutually exclusive choices: views of one panel, a filter, a range. More than that,
  or long labels, use a `Select`.
- Keep labels to a word or two; a trigger never wraps.
- Name the list when its tabs do not say what they choose between (`aria-label="Where the run came from"` on Flow
  Runs).
- Keyboard: Tab reaches only the active tab; the arrow keys move between tabs and select as they go, Home and End
  jump to the ends.

## Figma

Component set **TabsTrigger** (`1:2599`) on the `Navigation` page of tapflow-design-system — `state` × 4. The names
match this spec. The list is not in the set; draw it from the anatomy above.
