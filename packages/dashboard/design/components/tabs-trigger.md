---
component: TabsTrigger
source: components/ui/tabs.tsx
cva: tabsTriggerVariants
own: state
---

# TabsTrigger

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to TabsTrigger.

`components/ui/tabs.tsx` wraps Radix Tabs. This spec covers the trigger and the `TabsList` it sits in; `state` below
is what renders, not a prop. Two looks, set by `variant` on the list (`tabsListVariants`) and read by its triggers
(`tabsTriggerVariants`): a segmented control, a muted track with the active tab raised on it, and a line, an
underline under the active tab. The anatomy below is the segmented one.

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
- **Panel** (`TabsContent`) — 8px under the list (`mt-2`) by default. Two call sites have panels (below).

## Properties

### `variant`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `segmented` | Default. A 36px `--muted` track, 4px padding, the active tab raised on it (`--background`, `shadow-sm`) | 3 |
| `line` | No track. Tabs 16px apart (`gap-4`); the active one `--foreground` text over a 2px `--foreground` underline, the rest `--muted-foreground` over a transparent one. A press moves the label alone, not the underline | 1 |

Use `line` for views of one picture, where a raised track reads as a second frame around it (Flow Capture's Edit,
At this tap / After this tap).

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | No fill, `--muted-foreground` text — the track shows through (`line`: no underline) | 4 |
| `active` | `--background` fill, `--foreground` text, Tailwind `shadow-sm` (`line`: `--foreground` text and underline) | 4 |
| `focus` | Shared ring with a 2px `--background` offset (DESIGN.md), on keyboard focus only (`focus-visible:`) | 4 |
| `disabled` | 50% opacity, no pointer events; the arrow keys skip it | 1 — Flow Capture's After, on a step with no screen after it |

- **No `hover`.** An inactive tab does not change under the pointer.
- **Dark mode turns the active tab darker than the track.** `--background` (9%) on `--muted` (15%): the raised tab
  is a darker inset, not a lighter one. Draw both themes.
- **Pressed moves it 1px.** A trigger is a `<button role="tab">` with no `aria-haspopup`, so the global press motion
  applies (DESIGN.md). A `line` trigger opts out with `data-press-label` and moves its label alone, so the underline
  stays put; it wraps its children in a span to do so, so it cannot take `asChild`. That rule also replaces the trigger's own `transition-all`: color and fill change over 120ms,
  and the shadow appears at once.
- The focus ring's 2px offset is `--background`: on the light track (98% on 96%) it barely shows, and in dark mode it
  is a dark band between the tab and the ring. Draw both. The ring reaches 4px outside the tab, so it fills the list's
  height and runs under its neighbours; next to the active tab, that side of the ring is hidden by the active fill.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| QA session side panel — Comments / Recordings | List `w-full`, each trigger `flex-1 gap-1.5` with a 14px icon before the label; panels 12px under the list (`mt-3`) | Two equal halves of a 312px list, inset 4px (`px-1`) inside the 320px panel |
| Flow Runs — All / CI / Local | None. No panels: the tabs filter the list below | A source filter in the toolbar, beside 32px controls (the status Select and the search box) |
| Flow Capture's Edit — At this tap / After this tap | `line`. Left-aligned to the picture, 16px above it; After disabled on a step with no screen after it | A picture's width follows the device and its turn, so a centred switch would sit nowhere in particular; every step keeps the tabs so the picture keeps one size |
| Mac resources — 1h / 6h / 24h / 7d | None. No panels: the tabs set the chart's range | A range picker beside the Mac's name. The list has no name, so a screen reader hears "1h" with nothing saying it is a time range (tracked in #979) |

Two of the four are filters, not tabs over panels. They look and behave the same; Radix still gives them
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
