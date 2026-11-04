---
component: Toaster
source: components/ui/sonner.tsx
cva: none
own: type
---

# Toast (sonner)

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Toast.

**This is the shadcn Sonner toast**: the [sonner](https://sonner.emilkowal.ski) library (2.0.8) behind shadcn's
`components/ui/sonner.tsx` wrapper, in its current (new-york-v4) form. **It is not shadcn's own `Toast`
component**, which is a different, deprecated design. Use shadcn's Sonner page as the reference, not its Toast
page.

The wrapper is mounted once (`App.tsx`, `position="bottom-right"`, `richColors`) and a toast is raised in code with
`toast.success()`, `toast.error()` and the like. `type` below is which of those was called. The wrapper sets the
icons and maps sonner's neutral colors to our tokens; **the colored types use sonner's own palette**, not our
tokens.

## Anatomy

```
                                        ┌──────────────────────────────────────┐
                                        │ ⊗  Could not save                     │  356px wide, 16px padding
                                        │    The relay did not answer.          │  title + optional description
                                        └──────────────────────────────────────┘
                                                                          24px ↘ from the bottom-right corner
```

- **Box** — 356px wide, 16px padding, 1px border, `--radius` corners (8px), sonner's shadow (`0 4px 12px` black at
  10%). 54px high with a title; 74px with a one-line description. Title and description wrap, never truncate, and
  the box grows; the icon stays centered on the whole text block. Several descriptions run to two or three lines
  (a QA session that ended, an input failure with the agent's message), so draw one of those too.
- **Icon** — a 16px Lucide icon, in the toast's text color, vertically centered: `CircleCheck` (success), `Info`,
  `TriangleAlert` (warning), `OctagonX` (error), and a spinning `Loader2` while loading. 11px between the icon and
  the text.
- **Title** — 13px medium on a 19.5px line, in **Inter**, the dashboard's font, with its `ss01` / `ss02`
  alternates. The wrapper makes the toaster inherit it; sonner's own default is the system font (#1022).
- **Description** (optional) — 13px regular under the title, **in the same color as the title** on the colored
  types.
- **No close button, no action button.** Nothing in the dashboard passes one.
- **Place** — bottom-right, 24px from both edges. Over every page, above dialogs.

## Properties

### `type`

Light / dark values. The colored rows are sonner's `richColors` palette.

| Value | Fill | Text and icon | Border | Call sites |
|-------|------|---------------|--------|-----------:|
| `success` | `#ecfdf3` / `#001f0f` | `#008a2e` / `#59f3a6` | `#bffcd9` / `#003d1c` | 20 |
| `error` | `#fff0f0` / `#2d0607` | `#e60000` / `#ff9ea1` | `#ffe0e1` / `#4d0408` | 39 |
| `warning` | `#fffcf0` / `#1d1f00` | `#dc7609` / `#f3cf58` | `#fbeeb1` / `#2e2e00` | 4 |
| `info` | `#f0f8ff` / `#000d1f` | `#0973dc` / `#5896f3` | `#dde7fd` / `#19233e` | 1 |
| `loading` | `--popover` (`#ffffff` / `#1c1c1c`) | `--popover-foreground` (`#171717` / `#fafafa`) | `--border` (`#ebebeb` / `#2e2e2e`) | 1 |

Call-site counts are a snapshot (2026-10-21): each `toast.<type>()` written in code, plus the one `toast.promise()`
(Upload build), which shows `loading` and then turns into a `success` or an `error` toast in place.

- Text on its fill, light / dark: success 4.26 / 12.30, error 4.35 / 9.34, warning 3.08 / 11.12, info 4.35 / 6.56,
  loading 17.93 / 16.33. The light colored types are under the 4.5:1 that 13px text needs; that is left to the
  designer's color pass, not a value to aim for.
- A plain `toast()` would take the `loading` look without the spinner. Nothing calls it.

## Behaviour

- **Lifetime** — 4 seconds, paused while the stack is spread (pointer over it, or Alt+T) and while the browser tab is
  hidden. `loading` has no timer: it stays until the upload settles, then counts 4 seconds as `success` or `error`.
  Input-failure toasts on the device viewer stay 6 seconds and reuse one `id`, so repeats refresh one toast instead
  of stacking.
- **Stack** — newest at the bottom, up to three visible. Collapsed, each older toast peeks 14px above the one in
  front, 5% smaller per step, its content hidden and its height matched to the front toast. Spread (pointer over the
  stack), they sit 14px apart at full size.
- **Motion** — slides up from below the edge and fades in, 400ms; leaves by sliding back down and fading, 400ms. With
  reduced motion it appears and leaves at once.
- **Takes no action and does not move focus when it appears.** Each toast is still a tab stop, with sonner's own
  focus ring (2px black at 20% around the shadow, not DESIGN.md's `--ring`). Alt+T (Option+T on a Mac) moves focus
  to the stack and spreads it; Esc folds it. Dragging a toast down or right dismisses it. The stack is a polite live
  region.

## Usage

- Use a toast to confirm something just done (`success`) or to say that something failed (`error`). Most of the
  dashboard's toasts are one of these two.
- Say what happened in the title, in a few words. Put the cause or the next step in the description.
- Do not put anything the user must read to continue in a toast: it leaves on its own. A result that belongs to an
  open dialog is said inside the dialog (packages/dashboard/AGENTS.md, "A toast fired while a dialog is open is not
  heard").
- Raise it with `toast` from `'sonner'`. Mount nothing: the one Toaster is the wrapper in `App.tsx`, and a lint rule
  forbids mounting sonner's own.

## Figma

Component set **Toast (sonner)** (`23:749`) on the `Overlays` page of tapflow-design-system — `type` × 5, drawn from
the table above, with `Title`, `Description` and `Show description` properties. sonner's colors are the `Toast/*`
variables (Light and Dark), which are not CSS custom properties. The Inter `ss01` / `ss02` alternates are not
applied.
