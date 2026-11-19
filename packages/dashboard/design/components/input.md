---
component: Input
source: components/ui/input.tsx
cva: none
own: state, content
---

# Input

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Input.

`components/ui/input.tsx` has no `cva`: one class string, no props of its own beyond the native `<input>` ones.
`state` and `content` below are what renders, not props.

## Anatomy

```
┌──────────────────────────────────┐
│ you@company.com                  │   40px high
└──────────────────────────────────┘
 ↑ 12px                     12px ↑
```

- **Box** — 40px high (`h-10`), full width of its container, `rounded-md` (6px), 1px `--input` border,
  `--background` fill. No shadow.
- **Text** — 12px in from each side, 8px top and bottom (`px-3 py-2`). `--foreground`, inherited. Size depends
  on the viewport: **14px from 768px up** (`md:text-sm`), 16px below it (`text-base`), so a phone does not zoom
  in on focus. Draw the dashboard at 14px.
- **Placeholder** (optional) — same size, `--muted-foreground`.

There is no icon slot, prefix, suffix or clear button. `SearchInput` puts an icon over an Input from outside
(`components/ui/search-input.tsx`) and has its own row in DESIGN.md.

## Properties

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | Border `--input`, fill `--background` | 26 |
| `focus` | Shared ring (DESIGN.md) — the border stays `--input` under it | 26 |
| `disabled` | 50% opacity, `not-allowed` cursor | 0 — defined, no call site disables an Input |

**No `hover`.** Nothing changes under the pointer. **No `error`.** There is no `aria-invalid` style: 17 call
sites set `aria-invalid` when validation fails and the box looks the same, with the message shown below it by
`FieldError`. Do not draw a red border.

`focus` uses `focus-visible:`, but a text input matches `:focus-visible` on a mouse click too, so the ring shows
whenever the field is focused.

### `content`

| Value | Looks like | Where |
|-------|------------|-------|
| `empty` | Nothing in the box | Password and confirm fields, invite email, before anything is typed |
| `placeholder` | Placeholder text in `--muted-foreground` | 8 of 26: names, emails, bundle ID, token name |
| `filled` | Typed or preset value in `--foreground` | Every field after input; rename fields and read-only fields at rest |

`type="password"` renders the value as dots and `type="number"` gets the browser's spin buttons on hover —
neither is styled by us.

Call-site counts are a snapshot (2026-10-17).

## Variations at the call site

These are `className` overrides, not props.

| Where | Override | Why |
|-------|----------|-----|
| Read-only copy fields (invite or reset link, API token, agent command, `tapflow admin init`) — 4 | `readOnly` + `font-mono` | A value to copy, not to type; focusing it selects all |
| Run detail suggested line — 1 | `readOnly` + `h-7 min-w-0 font-mono` | The same, inline in a step row at 28px; `min-w-0` lets it shrink beside its Copy button on a narrow screen |
| `SearchInput` | `h-8 pl-8`, `w-48` by default | 32px search box with the icon in the left padding |

A read-only field looks the same as an editable one apart from the font: monospace at the same size (14px on
the dashboard), same border, same fill, same ring. Do not shrink it: a size override would have to beat
`md:text-sm` too, and the `text-xs` these fields used to carry did not — it applied only below 768px.
The invite or reset link and the new API token take focus as they appear (`Team.tsx`, `Tokens.tsx`), and focus
selects the whole value, so they are first seen with the ring on and the text all selected — the browser's
selection color, not a token of ours. Draw them in that state.

## Usage

- Every Input is named. A field with a visible `Label` points at it with `id` / `htmlFor` (21 of 26); a
  read-only copy field is named by the sentence above it through `aria-labelledby` (4); the run-detail line has
  an `aria-label`. A placeholder is not a name — it disappears once something is typed.
- An Input sits in the field assembly: `Label`, Input, then `FieldHint` or `FieldError` under it. See the Field
  row in DESIGN.md and [label.md](./label.md).
- Do not restyle the box per screen. The overrides above change font and height, and `SearchInput` also its left
  padding and width; no call site changes the border, fill or radius.

## Figma

Component set **Input** (`1:1931`) on the `Forms` page of tapflow-design-system — `state` × `content`, 9 variants.
`content` there is `placeholder`, `filled` and `mono`: `mono` is the read-only copy field above, at 14px, and
`empty` is not drawn.
