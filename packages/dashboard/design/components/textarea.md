---
component: Textarea
source: components/ui/textarea.tsx
cva: none
own: state, content
---

# Textarea

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Textarea.

`components/ui/textarea.tsx` is shadcn's Textarea: the [Input](./input.md) box made multi-line. It has no `cva`;
`state` and `content` below are what renders, not props. The dashboard has one: the comment field in the QA
session's side panel, where it gives up its own box to the composer around it (see Variations).

## Anatomy

```
┌──────────────────────────────────┐
│ Leave a comment…                 │   at least 80px high
│                                  │
│                                  │
└──────────────────────────────────┘
 ↑ 12px                     12px ↑
```

- **Box** — at least 80px high (`min-h-[80px]`), full width of its container, `rounded-md` (6px), 1px `--input`
  border (`#ebebeb` / `#2e2e2e`), `--background` fill. No shadow.
- **Text** — 12px inside the 1px border on each side, 8px top and bottom (`px-3 py-2`), `--foreground`. 14px from 768px up
  (`md:text-sm`), 16px below; draw the dashboard at 14px. Lines wrap; text past the box's height scrolls inside it.
- **Placeholder** (optional) — same size, `--muted-foreground`.
- **Resize handle** — the browser's, in the bottom-right corner, unless the call site turns it off (it does).

## Properties

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | Border `--input`, fill `--background` | 1 |
| `focus` | Shared ring (DESIGN.md): 2px `--ring`, 2px `--background` offset; the border stays `--input` under it | 1 — drawn on the composer, not the Textarea (below) |
| `disabled` | 50% opacity, `not-allowed` cursor | 0 — defined, never set |

As on Input: **no `hover`** and **no `error`**. A text field matches `:focus-visible` on a click too, so the ring
shows whenever it is focused.

### `content`

| Value | Looks like | Where |
|-------|------------|-------|
| `placeholder` | Placeholder in `--muted-foreground` | Before anything is typed, and again after a comment is posted |
| `filled` | The text in `--foreground`, wrapping | While writing |

Call-site counts are a snapshot (2026-10-20).

## Variations at the call site

### The comment composer

QA session → side panel → Comments. The panel is 320px wide with 4px on each side, so the composer is 312px.

```
┌────────────────────────────────────┐   composer: 1px --input border, rounded-md, --background
│ Leave a comment…                   │   Textarea: 64px min, no border, no fill, no ring
│                                    │
│ screenshot.png                     │   chosen file (12px, muted), or an error (12px, --destructive)
│ ⊞                              (↑) │   footer: 8px padding; attach 28px ghost; post 28px round
└────────────────────────────────────┘
```

| Part | Override | Why |
|------|----------|-----|
| Textarea | `min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm` | 64px, not 80px. No border, fill or ring of its own: the composer draws them around the text and the buttons together. No resize handle. 14px at every width |
| Composer box | `rounded-md border border-input bg-background`, and `focus-within:` the shared ring | The ring shows while focus is anywhere in it: the Textarea, the attach button or the post button, including after a mouse click on a button (`focus-within`, not `focus-visible`). Text sits 12px inside its 1px border |
| File line | 12px `--muted-foreground` file name; or 12px `--destructive` error (`Only png, jpg, webp allowed`, `Max 5MB`) | Shown only after an image is picked. A rejected pick shows only the error and drops the image picked before it. It sits 4px up into the Textarea's bottom padding (`-mt-1`), with 12px on the sides |
| Footer | Attach: ghost icon button, 28px, 16px `--muted-foreground` image icon, `--accent` fill on hover. Post: primary icon button, 28px, round, 16px up arrow (the code asks for 14px with `h-3.5`; Button's `[&_svg]:size-4` wins), `--primary` at 90% on hover | 8px padding around the row; Post sits at the right end. Each button also draws its own focus ring on keyboard focus, inside the composer's ring |

- **The composer is 110px high**: the 64px Textarea, the 44px footer and the 1px border top and bottom. The file line
  adds 16px, to 126px. Text past the Textarea's 64px scrolls inside it; nothing grows.
- **Post is disabled** (50%) until there is text that is not just spaces, or an image. While a post is sending it
  looks the same (50%, `not-allowed` cursor) but stays focusable (`aria-disabled`); pressing it again does nothing.
- **Enter makes a new line.** Nothing in the Textarea posts; only the post button does.
- After a successful post the field, the chosen image and any file error clear, so it shows its placeholder again,
  and focus moves into the field if it was still in the composer. A failed post leaves the text and image as they
  were, shows the error toast `Could not post the comment. Try again.`, and keeps focus on Post.

## Usage

- Use it for free text that can run to more than one line. One line belongs in an Input.
- **Every Textarea is named.** The composer's is `aria-label="Comment"`; its placeholder is a hint and is gone
  once someone types.
- Draw the base Textarea for the component set, and the composer as its own frame: the one place it is used, it
  looks like the composer, not like the base.

## Figma

Component set **Textarea** (`1:1967`) on the `Forms` page of tapflow-design-system — `state` × `content`, 6
variants. The names match this spec. The composer is not in the set.
