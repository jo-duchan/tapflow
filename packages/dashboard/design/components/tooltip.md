---
component: Tooltip
source: components/ui/tooltip.tsx
cva: none
own: content
---

# Tooltip

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Tooltip.

`components/ui/tooltip.tsx` wraps Radix Tooltip and has no `cva`. `content` below is what the call site puts
inside, not a prop. A tooltip names or explains the control under it, and should never be
the only place something is said: every trigger but one carries its own `aria-label` or description. The
exception is the overloaded Mac card, whose reason exists only in its tooltip (see Usage; tracked in #979).

## Anatomy

```
           ╭────────────────────────╮
           │ Screenshot  [⌘] [S]    │   ink at 85%, 11px text
           ╰────────────────────────╯
                    4px
               [ trigger ]
```

- **Box** — `--foreground` at 85% (`bg-foreground/85`), `rounded-lg` (8px), 7px side padding, 6px top and bottom
  (`px-[7px] py-1.5`). No border, no shadow, no arrow. 4px from the trigger (`sideOffset`). So in light mode it is
  near-black with white text, and in dark mode near-white with dark text: it inverts with the theme.
- **Text** — 11px (`text-[11px]`), regular weight, `--background` color, on the inherited 1.5 line (16.5px). That is
  smaller than any other text in the dashboard's controls; do not round it up to 12px.
- **Width** — as wide as its text. No max width is set. Most are a few words on one line, but a run-video step mark shows the flow's own step name,
  which can be any length, and the overloaded-Mac reason is a full sentence.
- **Motion** — opens in 150ms: fades in, scales from 95% and slides 8px from the trigger's side. Closes with a fade
  and scale back to 95%. Instant with reduced motion.

## Placement

`TooltipContent` takes Radix's `side` prop, but it is not an axis: there is no arrow, so a tooltip looks the same on
every side and only its position and the direction of its slide change.

| Side | Call sites | Where |
|-------|-----------:|-------|
| `top` | 6 | The default. Full reset switch and an overloaded Mac (QA session), the build row's **Edited** badge, the gap and step marks on the run video's timeline, a bundle ID row that cannot move in arrange mode (Settings → Apps), shown on the row itself, which has no handle |
| `left` | 12 | Every device toolbar button (the toolbar sits to the right of the device) |
| `right` | 1 | `SidebarMenuButton`'s `tooltip`, which shows only while the sidebar is collapsed to icons, and never on a phone. AppSidebar passes it on all three nav groups |
| `bottom` | 0 | Not used |

Radix flips a tooltip to the opposite side when there is no room.

## Properties

### `content`

| Value | Looks like | Call sites | Where |
|-------|------------|-----------:|-------|
| `text` | One line of 11px text | 13 | Names (`Launch app`), the build file's values on an **Edited** badge (`From the build file: 1.0 (12)`), names with a state (`Unfold: … — changing`, `Restarting the device`), a reason (`This Mac is currently overloaded. Try again later.`, why a bundle ID row cannot move in arrange mode), times on the video timeline |
| `shortcut` | The label, then 12px, then the keys as `Kbd` chips 4px apart | 6 | Toolbar: Deeplink ⌘K, Rotate ⌘⇧O, Screenshot ⌘S, Start / Stop recording ⌘⇧Y; iOS: Home ⌘⇧U, Software keyboard ⌘⇧K |

Call-site counts are a snapshot (2026-10-18): each row is a `TooltipContent` written in code, and the toolbar's
Android buttons are one row that renders a tooltip per button.

**`Kbd` inside a tooltip changes color.** Outside, a key chip is `--muted` with `--muted-foreground` text. Inside a
tooltip it is `--background` at 20% (10% in dark mode) with `--background` text, so it reads as a lighter
chip on the dark tooltip. It is 20px high, at least 20px wide, `rounded-sm` (4px), `text-xs` medium. A tooltip
with keys is 32px high, against about 28px for text alone.

A step mark on the video adds ` · failed` in `font-medium` for a failed step. That is the only weight change
inside a tooltip.

## Timing

How long the pointer has to rest before it opens. It is set by the `TooltipProvider` around the triggers.

| Delay | Where |
|-------|-------|
| 0ms | The collapsed sidebar |
| 150ms | The run video's timeline marks |
| 400ms | The device toolbar, the build row |
| 700ms | The QA session (Radix's default; its providers set no delay) |

Once one tooltip in a provider has opened, moving to the next trigger within 300ms opens it at once. Each QA
session card and the full reset switch have their own provider, so moving between them always waits. Keyboard focus opens a
tooltip with no delay. Moving the pointer onto the tooltip keeps it open.

## Usage

- Put a tooltip on an icon-only button to show its name, and add the shortcut when it has one. The button still
  needs its own `aria-label`; the tooltip is for people who see and point, and Radix describes the trigger with it
  only while it is open.
- Keep it to a few words. A sentence a user must read to act goes in the page, not in a tooltip.
- The trigger must be, or contain, something that takes focus, or the keyboard never sees the tooltip. The full
  reset switch hangs it on the wrapper around both the label and the Switch, not on the label alone: focus on the
  Switch bubbles up and opens it.
- **A disabled button shows no tooltip.** A `disabled` element gets no pointer events, so `Launch app` never shows
  `Launching…` or `Installing…`, though the code writes them. A busy control that must explain itself uses
  `aria-disabled` and stays enabled, as the toolbar's posture, restart, recording, network and software keyboard
  buttons do. An overloaded Mac card instead wraps its disabled button in a focusable `span`: the tooltip opens, but
  that stop has no role and no name, and the reason exists only in the tooltip (tracked in #979).

## Figma

A single component **Tooltip** (`83:432`) in the `Design System` page, with no variants, and deliberately no
`side` axis (see Placement). The `shortcut` content and the inverted `Kbd` are not in it; adding `content` is one of
the items for the Figma sync.
