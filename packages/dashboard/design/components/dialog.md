---
component: Dialog
source: components/ui/dialog.tsx
cva: dialogVariants
own: actions
---

# Dialog

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Dialog.

`components/ui/dialog.tsx` wraps Radix Dialog. Its one prop axis is `size`, the panel's width (`dialogVariants`).
`actions` below is how the call site lays out its buttons, not a prop. A confirmation that asks "are you sure?" is `AlertDialog`, a separate component.

## Anatomy

```
┌───────────────────────────────────────────┐
│ Title                                   ✕ │   DialogHeader
│ Description (optional)                    │     6px between (space-y-1.5)
│                                           │   16px (gap-4)
│ Body — fields, copy fields, text          │
│                                           │   16px
│ Actions                                   │
└───────────────────────────────────────────┘
  24px padding on every side
```

- **Overlay** — black at 80% over the whole page, in both themes. Fades in and out over 150ms.
- **Panel** — `--background` fill (not `--card` or `--popover`), 1px `--border`, `rounded-lg` (8px), Tailwind
  `shadow-lg` (not a `shadow-card-*` token), 24px padding. Centered in the viewport. Children are stacked
  16px apart (`grid gap-4`). Opens and closes in 150ms: fades and scales between 95% and 100%, with no slide
  (`tailwindcss-animate`, #984). With the OS set to reduce motion it appears and disappears instantly.
- **Title** — `text-lg` (18px) `font-semibold leading-none tracking-tight`, `--foreground`. Required on every
  dialog; the deeplink bar hides it visually (`sr-only`).
- **Description** (optional) — `text-sm`, `--muted-foreground`. 4 of 9 dialogs.
- **Close** — 16px ✕ in the top-right corner, 16px from the top and right edges, 70% opacity, 100% on hover.
  Its focus ring uses `focus:`, so it shows on a click too. Last in the tab order, after the actions.

**Below 640px** the corners are square and the header is centered, and on a phone the panel fills the width
(`w-full` up to its `size`, with no side margin). The dashboard is drawn
at desktop width, where the header is left-aligned and the corners are 8px.

## Properties

### `size`

| Value | Width | Call sites | For |
|-------|------:|-----------:|-----|
| `sm` | 384px (`max-w-sm`) | 1 | A short form of one to three fields with no description: Add App |
| `md` | 448px (`max-w-md`) | 5 | A new item's form, a notice, or a result to copy, with or without a description: Invite member, Password reset link, Create token, Upload build, Streaming in Standard mode |
| `lg` | 512px (`max-w-lg`) | 4 | The default. A form that edits an existing item, with a description or hints under its fields: Edit app, Split, Rename device, Edit build. AlertDialog is always this width |

Three sizes rather than a width per dialog (#1084 review). Pick by what the body holds, not by what looks right
for one dialog: a new dialog takes the size of the row above whose "For" it matches, and a fourth size is a
change to this table first. The deeplink bar is outside the scale: it is a command bar, not a panel.

### `actions`

| Value | Looks like | Call sites | Where |
|-------|------------|-----------:|-------|
| `stacked` | One primary button, full width, at the bottom of the body | 4 | Invite member, Password reset link, Create token, Add App |
| `end` | Cancel (`outline`) and the primary action, 96px each (`w-24`), right-aligned, 8px apart | 1 | Upload build |
| `footer` | `DialogFooter`: secondary and primary right-aligned, 8px apart; below 640px stacked with the primary on top | 5 | Streaming in Standard mode, Edit app and Split (Settings → Apps), Rename device (QA session picker), Edit build (App Center) |
| `inline` | No action row; the one button sits inside the bar beside the field | 1 | Open deeplink |

**Two buttons side by side whose labels are about as long take the same width**: 96px (`w-24`) for Cancel and
Save or Upload, 112px (`w-28`) where a busy label would not fit 96 (`Splitting…`). Edit app, Split, Rename device
and Edit build follow it in `footer`, as Upload build does in `end`.

Call-site counts are a snapshot (2026-10-18). `stacked` is what a form dialog does: fields, then the submit
button stretched to the panel's width. A dialog whose form is replaced by a result (the invite link, the new
token, the reset link) keeps the same shape — the copy field, then one full-width button (`Done`, `Copy & close`),
12px apart (`gap-3`) where the form's fields are 16px apart (`gap-4`).

`DialogFooter` is used three times. `stacked` and `end` are plain `div`s or the `<form>` itself, which is why the
Figma set's `footer` axis (with / without) does not describe what ships.

There is no state axis: the panel itself is not interactive. The buttons, fields and Close follow their own
specs.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Streaming in Standard mode | Description split into two paragraphs 12px apart, with 4px more above it (`pt-1`) | A notice, not a form |
| Open deeplink | 500px × 52px bar, `rounded-[18px]`, 10px padding, Close hidden (`[&>button]:hidden`), title `sr-only` | A command bar (⌘K), not a dialog-shaped panel |

Inside the deeplink bar: a borderless, unfilled field (16px search icon in `--muted-foreground`, 8px gap,
`text-sm`, placeholder `myapp://home...`) in a 32px row, then 12px, then the `Open` button at `size="sm"`
overridden to 32px high, 16px side padding and `rounded-xl` (12px).
| Form and result bodies | `pt-2` | Adds 8px, so the body starts 24px under the title |

The deeplink bar is the one dialog that does not look like a dialog. Draw it from the overrides above, not from
the panel.

## Usage

- Use Dialog for a task: a form, or a value to copy. Use AlertDialog to confirm a destructive action.
- Give it a title even when it is not shown. Name the action on the primary button (`Generate invite link`,
  `Create token`), not `OK`.
- Do not add a Cancel button to a `stacked` dialog. Close (✕), Escape and a click on the overlay all dismiss it.
- When a form is replaced by its result, keep the panel and the title; swap the body only.
- **Open it from a `DialogTrigger`, or return focus yourself.** Radix puts focus back on the trigger when the
  dialog closes. Opened from a plain `onClick`, a shortcut or on mount there is no trigger, so focus drops to the page unless the call site
  passes `onCloseAutoFocus` (Password reset link does). Two dialogs do neither today (tracked in #979).

## Dialog vs AlertDialog

They share the panel, overlay and motion, and AlertDialog has Dialog's `lg` width. What differs:

| | Dialog | AlertDialog |
|---|---|---|
| Header spacing | 6px (`space-y-1.5`) | 8px (`space-y-2`) |
| Title | `text-lg font-semibold leading-none tracking-tight` | `text-lg font-semibold` |
| Close (✕) | Yes | No — it closes only through its buttons or Escape, not on an overlay click |
| Focus on open | First focusable element | Cancel |
| Buttons below 640px | `DialogFooter` stacks them with no gap | Cancel carries `mt-2`, so they sit 8px apart |
| Role | `dialog` | `alertdialog` |

## Figma

Component set **Dialog** (`85:454`) in the `Design System` page — `footer` × 2. As above, that axis does not
match the four `actions` layouts in code; this is one of the items for the Figma sync. It has no `size` axis
either; adding sm / md / lg (384 / 448 / 512) is another.
