---
component: Select
source: components/ui/select.tsx
cva: none
own: size, state, content
---

# Select

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Select.

`components/ui/select.tsx` wraps Radix Select and has no `cva`. `size`, `state` and `content` below describe
the trigger as it renders; `size` is a `className` height at the call site, not a prop.

## Anatomy

```
Trigger (closed)
┌──────────────────────────────┐
│ In Progress               ⌄  │   value + chevron
└──────────────────────────────┘
Content (open), 4px below the trigger
┌──────────────────────────────┐
│    Backlog                   │   item
│ ✓  In Progress               │   selected item: check on the left
│ ░░ Done ░░░░░░░░░░░░░░░░░░░░ │   highlighted item: --accent
│    Rejected                  │
└──────────────────────────────┘
```

On open the highlight starts on the selected item, so the first frame has the check and the `--accent` fill on
the same row.

- **Trigger** — same box as Input: full width unless overridden, 1px `--input` border, `--background` fill,
  `rounded-md` (6px), 12px side padding. Text `text-sm` (14px) at every viewport, `--foreground`, one line
  (longer values are clipped with an ellipsis). Chevron-down 16px at 50% opacity, pinned to the right.
- **Content** — `--popover` surface, `--popover-foreground` text, 1px `--border`, `rounded-md`, Tailwind
  `shadow-md` (not a `shadow-card-*` token). At least as wide as the trigger and never narrower than 128px; it
  grows to fit its longest item, aligned to the trigger's left edge, so extra width extends to the right. 4px
  padding inside. Opens 4px below the trigger (above when there is no room) in 150ms: fades, scales from 95% and
  slides 8px from the trigger's side (instant with reduced motion). A list taller than the space available scrolls, with a 16px chevron
  button at the top and bottom.
- **Item** — `text-sm`, 6px top and bottom, 32px left padding (room for the check), 8px right, `rounded-sm` (4px).
  Always 14px, even when the trigger is set to 12px.
- **Check** — 16px, in a 14px slot 8px from the item's left edge, only on the selected item.

`SelectLabel`, `SelectGroup` and `SelectSeparator` are exported and used nowhere. Do not draw groups or
dividers inside a Select.

## Properties

### `size`

| Value | Height | Call sites | Where |
|-------|--------|-----------:|-------|
| `h-10` | 40px — the base class | 5 | Form fields: token expiry and type, invite role, upload status, app platform |
| `h-9` | 36px, text 12px (`text-xs`) | 1 | Build row status in App Center |
| `h-8` | 32px | 4 | Toolbar filters (App Center status, Runs status, QA session OS version) and the run video's speed (text 12px) |
| `h-7` | 28px | 1 | Role cell in the Team members table |

Call-site counts are a snapshot (2026-10-18). The height always comes with a width override except at
`h-10`, which fills its field: `w-36` (144px) on the three filters, `w-32` (128px) on the build row,
`w-28` (112px) on the role cell, `w-20` (80px) on the speed.

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | Border `--input`, fill `--background` | 11 |
| `focus` | Shared ring (DESIGN.md) | 11 |
| `disabled` | 50% opacity, `not-allowed` cursor | 0 — defined, no call site disables a Select |

- **No `hover`.** The trigger does not change under the pointer.
- **The ring shows on a mouse click too.** The trigger uses `focus:`, not `focus-visible:`. While the list is
  open, focus is on the selected item, so the trigger shows no ring; it gets focus, and the ring, back when the
  list closes.
- **Open is not a trigger look.** Nothing about the trigger changes while the list is open — the chevron does
  not turn. Draw the open state as the trigger at `default` (no ring) plus the content, with the selected item
  highlighted.
- **Pressed moves it 1px.** The trigger is a `<button>` with `role="combobox"` and no `aria-haspopup`, so the
  global press motion applies (DESIGN.md).
- **No `error`.** The invite role trigger wires `aria-invalid`, which cannot be true today (the role defaults to
  QA), and nothing styles it.

### `content`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `value` | The selected item's content, `--foreground` — the build row's `none` shows its item's muted `—` | 11 |
| `placeholder` | Placeholder text, `--muted-foreground` | 0 — every Select starts with a value |

Every Select is given a value before it renders: a form default, `'none'`, or an "All / Any" item. App Center's
status filter declares a placeholder ("Status"), but its value starts at `all`, so it never shows. A "no
choice" option is a real item at the top of the list (`All statuses`, `Any status`, `Any version`, `None`, or a
muted `—` on the build row), not a placeholder.

## Item states

Items are not a separate component in Figma terms, but they have their own looks.

| State | Looks like | Notes |
|-------|------------|-------|
| `default` | `--popover-foreground` text, no fill | |
| `highlighted` | `--accent` fill, `--accent-foreground` text | Mouse over it or arrow-key focus — the same look, because Radix moves focus to the item under the mouse. On open it starts on the selected item; moving the mouse off the items clears it |
| `selected` | Check on the left | Can be highlighted at the same time |
| `disabled` | 50% opacity, not clickable | 0 call sites |

There is no focus ring inside the list: the highlighted fill is the focus indicator.

## Usage

- **Name every trigger.** In a form, a `Label` with `htmlFor` pointing at the trigger's `id` (token expiry,
  token type, invite role, app platform). Outside a form — toolbars and table cells — an `aria-label`
  ("Filter by status", `Status for <build>`, "Playback speed"). The Team role cell still has neither
  (tracked in #979).
- Use `h-10` in a form, `h-8` in a toolbar, and the smaller heights only inside a dense row (`h-9` build row,
  `h-7` table cell). Set a width whenever the height is overridden.
- Item text says what the option does, not just its key: `API — CI uploads & API access`. Content grows to fit
  it, so a long item makes the list wider than its trigger.

## Figma

Component set **Select** (`1:1993`) on the `Forms` page of tapflow-design-system — `size` × `state` × `content`, 24
variants. The names match this spec. The content list and items are not in that set.
