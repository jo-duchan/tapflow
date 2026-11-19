---
component: Kbd
source: components/ui/kbd.tsx
cva: none
own: context
---

# Kbd

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Kbd.

`components/ui/kbd.tsx` is shadcn's Kbd: one key drawn as a small chip, and `KbdGroup`, a row of them. It has no
`cva` and no props of its own. Its look changes with where it sits, which is `context` below, not a prop. Every Kbd
in the dashboard is inside a tooltip, naming a device-toolbar shortcut.

## Anatomy

```
Rotate            ┌──┐ ┌──┐ ┌──┐
                  │⌘ │ │⇧ │ │O │      key: 20px high, at least 20px wide, rounded-sm
                  └──┘ └──┘ └──┘
       12px          4px  4px         group: keys 4px apart
```

- **Key** — 20px high (`h-5`), at least 20px wide (`min-w-5`), 4px padding on the sides (`px-1`), `rounded-sm`
  (4px). `text-xs` (12px) medium, centered. Every key in use is one character, so each chip is about a 20px
  square; a longer label (`Esc`) would widen it. The 12px is set on Kbd, not inherited: in a tooltip it sits beside
  an 11px label.
- **Glyphs** — the keys are typed characters, not icons. Letters (`K`, `O`, `S`, `U`, `Y`) are Inter. **`⌘` and `⇧`
  are not in the Inter files the dashboard loads** (their `unicode-range` stops short of them), so the browser draws
  them in the system font: SF Pro on a Mac. Draw them that way rather than in Inter.
- **Icon** — an SVG inside a key is 12px (`size-3`), 4px from any text beside it (`gap-1`). No call site uses one.
- **Group** — `KbdGroup`: the keys in a row, 4px apart (`gap-1`). In a tooltip the group sits 12px after the label
  (`gap-3`, from the call site).
- **Not interactive.** No pointer events and no text selection: the pointer acts on the tooltip under the chip. It
  has no states.

## Properties

### `context`

Light / dark values. The tooltip itself is `--foreground` at 85% (about `#393939` / `#d8d8d8` on the page).

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | `--muted` fill (`#f5f5f5` / `#262626`), `--muted-foreground` text (`#888888` / `#a6a6a6`) | 0 — defined, nothing uses it |
| `tooltip` | `--background` at 20% fill (10% in dark), `--background` text (`#fafafa` / `#171717`). Comes to about `#606060` / `#c5c5c5` on the tooltip | 6 |

Call-site counts are a snapshot (2026-10-20): the six tooltips with a shortcut, listed in
[tooltip.md](./tooltip.md) (`content` → `shortcut`). Four are the shared toolbar's, built by one helper (Record shows Start or
Stop recording, by state), and appear on Android too; two are the iOS viewer's.

- **`tooltip` is chosen by the parent, not set.** A Kbd inside `TooltipContent` (`data-slot="tooltip-content"`)
  switches to it on its own.
- On the tooltip the chip is a slightly lighter patch: 1.84:1 against the tooltip in light mode, 1.21:1 in dark.
  Its text is 6.02:1 and 10.39:1. Draw it at those values.
- `default` text is 3.25:1 on its fill in light mode and 6.22:1 in dark.

## Usage

- Use it for a keyboard shortcut next to the name of what it does, inside the tooltip of that control. One Kbd per
  key, in a `KbdGroup`.
- Keys are written in the order the code lists them, modifiers first: `⌘` `⇧` `O`. That is not the order macOS menus
  use (`⇧⌘O`). Draw what ships.
- The shortcuts are Mac ones. The viewers match the Command key (`metaKey`) only, and the tooltip shows `⌘` on every
  system.
- Kbd itself has no role or label, and the shortcut is never part of the button's name (its `aria-label`). While the
  tooltip is open, Radix points the button's `aria-describedby` at it, so on Deeplink, Rotate, Screenshot and Home a
  screen reader can read the label and keys as the description. Record and Software keyboard set their own
  `aria-describedby`, so theirs are not read.

## Figma

A single component **Kbd** (`1:2662`) on the `Data display` page of tapflow-design-system, with no variants: the
`tooltip` look only, on the `Kbd/Background` token (`--background` at 20% in light mode, 10% in dark). `default` is
deliberately not drawn, since nothing uses it. Kbd is not yet inside the Tooltip component (see
[tooltip.md](./tooltip.md)).
