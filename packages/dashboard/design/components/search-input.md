---
component: SearchInput
source: components/ui/search-input.tsx
cva: none
own: state, content
---

# SearchInput

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to SearchInput.

`components/ui/search-input.tsx` is an [Input](./input.md) with a search icon laid over its left padding. It has no
`cva`; `state` and `content` below are what renders, not props. It is the filter box at the head of a list: three
call sites, each in a filter row. In App Center and Flow Runs it sits beside a status `Select`; in the QA session
beside an OS-version `Select` that appears only when the devices report a version. Flow Runs' row also holds the
36px source tabs, with everything centered vertically.

## Anatomy

```
┌──────────────────────────────┐
│ ⌕  Search version…           │   32px high, 192px wide
└──────────────────────────────┘
 ↑10px ↑33px                12px↑
```

- **Box** — the Input box, shortened: 32px high (`h-8`, not Input's 40px) and 192px wide (`w-48`). `rounded-md`
  (6px), 1px `--input` border (`#ebebeb` / `#2e2e2e`), `--background` fill. No call site changes the width.
- **Icon** — Lucide `Search`, 16px, `--muted-foreground`, 10px from the left edge (`left-2.5`), centered vertically.
  It does not change with the state and takes no pointer events: a click on it lands in the field.
- **Text** — 32px of left padding inside the 1px border (`pl-8`), so 33px from the outer edge and 7px after the
  icon; 12px padding on the right. 14px, as on
  Input (16px below 768px; draw the dashboard at 14px). Centered vertically in the 32px.
- **Placeholder** — same size, `--muted-foreground`. It ends in an ellipsis on two of the three (`Search device…`,
  `Search version…`), not on the third (`Flow name`).

There is no clear button and no submit. The field sets no `type`, so it is a plain text field rather
than `type="search"`, and the browser adds no clear control of its own.

The 32px matches the `h-8` Select triggers beside it. Input and Select are 40px by default; every filter row
overrides both to 32px.

## Properties

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | Border `--input`, fill `--background`. The border is faint: 1.14:1 against the fill in light mode, 1.32:1 in dark | 3 |
| `focus` | Shared ring (DESIGN.md): 2px `--ring`, 2px `--background` offset; the border stays `--input` under it | 3 |
| `disabled` | 50% opacity on the box, `not-allowed` cursor; the icon stays at full strength | 0 — defined by Input, never set |

As on Input: **no `hover`** and **no `error`**. A text field matches `:focus-visible` on a click too, so the ring
shows whenever it is focused.

### `content`

| Value | Looks like | Where |
|-------|------------|-------|
| `placeholder` | Placeholder in `--muted-foreground`: 3.40:1 on the fill in light mode, 7.36:1 in dark | Every call site, until something is typed |
| `filled` | The search text in `--foreground` | After typing; Flow Runs also opens filled when the page's address carries a flow |

Every call site has a placeholder, so there is no `empty` look.

Call-site counts are a snapshot (2026-10-20).

## Variations at the call site

| Where | Placeholder · name | What it filters |
|-------|--------------------|-----------------|
| QA session — Select device | `Search device…` · "Search devices" | The device list, on every keystroke: names containing the text, ignoring case |
| App Center — builds | `Search version…` · "Search versions" | The release list, 250ms after typing stops: version names containing the text, ignoring case for A–Z (the build number is not searched) |
| Flow Runs | `Flow name` · "Flow name" | The run list, 300ms after typing stops: flow names containing the text, ignoring case for A–Z. The trimmed text is kept in the page's address |

App Center's box is also described by its loading line or the empty-list title, and takes focus when the view below it
is replaced by a loading or empty view with no control of its own while focus was in the view being replaced (a
release row, or the failure screen's retry) (`AppCenter.tsx`). That changes nothing on screen beyond the focus ring.

## Usage

- Use it to narrow a list already on screen, at the head of that list, beside the list's other filters.
- **Every SearchInput is named.** `aria-label` is a required prop; a placeholder is not a name, since it disappears
  once something is typed. Write the placeholder as a hint (`Search version…`) and the name as what the field is
  (`Search versions`). Flow Runs uses `Flow name` for both, which works as a hint too.
- The icon is decorative and hidden from assistive technology. The field is named by its label, not by the icon.
- Results change as the text changes; there is no Enter to submit (no call site is inside a form).
  Escape does nothing.

## Figma

Component set **SearchInput** (`1:2131`) on the `Forms` page of tapflow-design-system — `state` × `content`, 6
variants. The names match this spec.
