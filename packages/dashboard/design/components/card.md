---
component: Card
source: components/ui/card.tsx
cva: cardVariants
---

# Card

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Card.

`level` below is the key set of `cardVariants` in `components/ui/card.tsx`, which is the source of truth.

## Anatomy

```
┌─────────────────────────────────┐
│ CardHeader            p-6       │
│   CardTitle                     │
│   CardDescription   (optional)  │   gap 6px (space-y-1.5)
│                                 │
│ CardContent           p-6 pt-0  │
│   …                             │
└─────────────────────────────────┘
```

- **Container** — `--card` surface, `--card-foreground` text, `rounded-lg` (8px). Elevation comes from `level`.
  No border: the 1px edge is an inset shadow inside every level from 1 up.
- **CardHeader** — 24px padding, title and description stacked 6px apart. 13 of 13 cards have one.
- **CardTitle** — `text-2xl font-semibold leading-none tracking-tight`, `--card-foreground`. It is a `div`, not a heading.
- **CardDescription** (optional) — `text-sm`, `--muted-foreground`. 6 of 13 cards.
- **CardContent** — 24px padding on the sides and bottom, none on top, so it sits 24px under the header.
- **CardFooter** — exported, used nowhere. Do not draw it; actions sit inside CardContent.

## Properties

### `level`

| Value | Shadow (`tailwind.config.ts`) | Call sites | Use |
|-------|-------------------------------|-----------:|-----|
| `0` | none | 0 | Defined, not used |
| `1` | `shadow-card-1` — 1px inset hairline only | 0 | Defined, not used |
| `2` | `shadow-card-2` — soft 1–2px drop + hairline | 7 (it is the default) | Settings sections, lists |
| `3` | `shadow-card-3` — stacked 2px and 8px drop + hairline | 0 | Defined, not used |
| `4` | `shadow-card-4` — float stack, 16px blur + hairline | 6 | The one card on an entry screen: Login, Setup, Invite, Reset password |

Call-site counts are a snapshot (2026-10-17). Login and Setup put a logo lockup 24px above the card (24px logo,
`tapflow` in `text-base font-semibold`); Invite and Reset password have none. The lockup is part of the page, not
the card. The App Center release list also draws a level-2 surface without
`Card` (`ReleaseAccordion.tsx:40`, `rounded-lg shadow-card-2` on a plain `div`), so it looks like a card but is not
one. Only `2` and `4` are in use, so a screen is either the settings
pattern (several `2` cards on the page background) or the entry pattern (one centered `4` card).

**The shadows do not change in dark mode.** They are black at 2–8% alpha in both themes, so on the dark page
(`--background` 9%) a card reads mostly by its lighter surface (`--card` 11%) and the hairline nearly disappears.
Draw dark cards with the same shadow values, not a lighter outline.

### No states

No call site gives a Card `onClick`, so it has no `hover`, `focus` or `pressed` look. A clickable card is a new
component — propose it as a code change first.

## Variations at the call site

These are `className` overrides, not props. All but one change layout, not the look of the card.

| Where | Override | Why |
|-------|----------|-----|
| Entry screens (Login, Setup, Invite, Reset password) | Card `w-full`; 384px wide (`max-w-sm`) on all six — on the card itself, or on the wrapper for Login and Setup | One narrow card, centered by the page |
| Entry screens with a form (four) | CardHeader `text-center` | Title and description centered over a left-aligned form |
| Invite and Reset password result cards (two) | Card `text-center` | A status message with no form, all of it centered |
| Login, Setup | CardTitle `tracking-display-md` (-0.96px) | Display tracking on the two entry titles; every other title keeps `tracking-tight` |
| Members (Team), Tokens | CardContent `px-4 pt-0 pb-2` | The content is a table, which brings its own cell padding |

## Usage

- Use `level={2}` (or omit it) for sections on a page, and `level={4}` for the single card of an entry screen.
  Levels 0, 1 and 3 exist in code but no screen uses them yet.
- One title per card. The title names the section; do not repeat it as a heading inside CardContent.
- A list or table in a card uses the dense CardContent padding above (16px), and the table cells add their own
  16px, so table text starts 32px in while the title starts at 24px. That offset is how it renders today — draw
  it as is.

## Figma

Component set **Card** (`57:74`) in the `Design System` page — one variant per `level`, with `level=2` as the
default (top left of the set) to match `defaultVariants`.
