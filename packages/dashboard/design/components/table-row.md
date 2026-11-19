---
component: TableRow
source: components/ui/table.tsx
cva: none
own: type, state
---

# TableRow

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to TableRow.

`components/ui/table.tsx` is shadcn's Table: `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`,
`TableCell`, and a footer and caption nothing uses. It has no `cva`. This spec covers a row and the cells in it;
`type` and `state` below are what renders, not props. Three tables use it: Flow Runs, Settings → Tokens and
Settings → Team.

## Anatomy

```
Flow Runs, 4 of its 6 columns
┌───────────────────────────────────────────────────────────┐
│  Status        Build           Flows passed   Started     │  header row: 48px
├───────────────────────────────────────────────────────────┤  1px --border
│  [Passed]      main · 42       3/3            2h ago      │  body row: 16px padding, 54px here
├───────────────────────────────────────────────────────────┤
│  [Failed]      main · 41       1/3            3h ago      │  last row: no bottom border
└───────────────────────────────────────────────────────────┘
 ↑16px
```

- **Table** — full width of its container, `text-sm` (14px on a 20px line) for every cell. It scrolls sideways
  inside its own box when the columns do not fit; the page does not.
- **Header cell** (`TableHead`) — 48px high (`h-12`), 16px on the sides (`px-4`), no padding above or below.
  `text-sm` medium, `--muted-foreground`, left-aligned, vertically centered.
- **Body cell** (`TableCell`) — 16px on every side (`p-4`), vertically centered, `--foreground` unless the call site
  says otherwise. A row is as tall as its tallest cell plus 32px: 52px for a line of text, 54px with a Badge (Flow
  Runs), 60px with a 28px button or select (Tokens, Team).
- **Borders** — 1px `--border` (`#ebebeb` / `#2e2e2e`) under the header row and under every body row except the last.
  No vertical lines, no zebra striping, no fill of its own: the row shows the surface it sits on.
- **Container** — the table has no border or radius of its own. Flow Runs puts it in a `rounded-md` box with a 1px
  border and `--card` fill; Tokens and Team put it in a Card, with 16px on the sides and 8px below (`px-4 pt-0
  pb-2`). Draw it on `--card` (`#ffffff` / `#1c1c1c`).

## Properties

### `type`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `header` | Header cells as above, 48px, border below | 3 — one per table |
| `body` | Body cells as above, border below unless last | 3 — one per table, plus the state rows below |

### `state`

Light / dark values, on `--card`.

| Value | Trigger | Fill | Call sites |
|-------|---------|------|-----------:|
| `default` | — | None | 3 |
| `hover` | `hover:` | `--muted` at 50% (`#fafafa` / `#212121`), with a 150ms color transition | 3 header rows, 1 body row (Flow Runs) |
| `selected` | `data-state="selected"` | `--muted` (`#f5f5f5` / `#262626`) | 0 — defined, no row is selected |

- **Header rows take the hover fill too**, since the state is on `TableRow` and no header row turns it off. Draw it.
- **Only Flow Runs' body rows react to the pointer.** Tokens and Team turn the fill off on theirs
  (`hover:bg-transparent`): nothing happens on a click there, only in the row's own controls.
- The hover fill is faint: 1.04:1 against `--card` in light mode, 1.06:1 in dark. The row border is 1.19:1 and
  1.25:1. Header text is 3.54:1 and 7.00:1, and 3.44:1 and 6.61:1 on a hovered header row. Draw them at those values.
- There is no focus style on a row. A row does not take focus; the controls in it do, each with its own ring.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Flow Runs — a run | `cursor-pointer`; a click anywhere in the row opens the run (⌘ or Ctrl opens it in a new tab) | Opening a run is the one thing to do with it, as in a CI run list. The build name is a link too (medium weight, underline on its own hover, ring on focus), and it is the row's only keyboard stop |
| Tokens, Team — a token or member | `hover:bg-transparent` | The row is not a target. Its actions are its own controls: Revoke (a 28px destructive icon button, a red trash icon on a 10% red tint) in Tokens; a 28px role select and two 28px buttons, Reset pwd and Remove, in Team |
| Every table — no rows | One row across all columns, `hover:bg-transparent`, its cell 80px high (`h-20`), centered `--muted-foreground` text | Empty: the table's own sentence ("No tokens yet."). Failed: "Couldn't load tokens." and an outline **Try again** button, 36px high (`size="sm"`), 12px after it; the cell stays 80px |
| Every table — loading | Nothing for the first 250ms but an empty 80px row; then three rows of `--muted` bars (`rounded-md`, pulsing), 16px high and 112 / 160 / 64 / 80px wide by column (repeating from 112 in a fifth column), every column alike. Each row is as tall as the table's real rows: 60px in Tokens and Team, 54px in Flow Runs (`rowHeight`) | Bars shaped like the rows on their way, so a quick answer does not flicker, and as tall as them, so the table does not jump when they arrive |

In Flow Runs the `body` cells also carry their own colors: Source and Started are `--muted-foreground`, Flows passed
and Duration are `TechLabel` (see [tech-label.md](./tech-label.md)), and Status is a Badge ([badge.md](./badge.md)).
In Tokens, Name is medium weight, Scope is a secondary Badge, Last used is `--muted-foreground`, and Expires is a
`--muted-foreground` date, `Expired` in `--destructive`, or an outline Badge reading `No expiration`. In Team,
Nickname is medium weight (`—` when there is none), Email and Joined are `--muted-foreground`, and the role select is
112px wide. Both put the actions under an empty 40px header cell (`w-10`).

Call-site counts are a snapshot (2026-10-20).

## Usage

- Use a table for records with the same fields, one per row, that someone scans across. Put the record's name or
  status in the first column.
- Make a whole row clickable only when the row has one obvious action, as Flow Runs does. Then give the row a link
  that names it, so the keyboard and a screen reader have the same way in. Otherwise turn the hover off and put the
  actions in the last column.
- A table never shows an empty body. It shows the loading row, the empty sentence or the failure with a retry.

## Figma

Component set **TableRow** (`1:2461`) on the `Data display` page of tapflow-design-system — `type` × `state`, 6
variants. The names match this spec. The table container is not in the set; draw the rows on it, as the spec frame
does.
