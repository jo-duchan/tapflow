---
component: Stepper
source: components/ui/stepper.tsx
cva: none
own: state
---

# Stepper

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Stepper.

`components/ui/stepper.tsx` shows where a multi-step task stands: Capture flow's Range → Match → Edit → Verify →
Export. Its look follows shadcn/studio's Radix stepper (variant 04: number and title on one line, a line between
steps), rebuilt here rather than installed so the dashboard takes no new dependency.

## Anatomy

```
 (1) Range ──── (2) Match ──── (3) Edit ──── ...
  └ indicator 24px  └ title 13px   └ separator 2px, 48px
```

- **List** — an `<ol>` with an accessible name (`label`), items 8px apart (`gap-2`).
- **Indicator** — a 24px circle (`size-6 rounded-full`), `text-xs font-medium`. A completed step shows a 14px check
  instead of its number.
- **Title** — 13px, line height 20px. Medium and `--foreground` on the active step, regular `--muted-foreground` on
  the others.
- **Separator** — 2px `--border` track, 48px wide (`w-12`), shrinking when the list runs out of room. Once the step
  before it is completed, a `--primary` fill grows across it from the left. Decorative (`aria-hidden`).

## Motion

From the reference: the indicator's fill and ring ease over 300ms (`transition-all duration-300`), and the separator
fills over 500ms (`scale-x`, `ease-out`). Both are off under `prefers-reduced-motion`.

## Properties

### `state`

Not a prop: each item's state follows from `current` and `reached`. A step after `current` is `completed` when the task
reached it and stepped back (`reached`, which defaults to `current`), so stepping back does not hide what is still
there to return to.

| Value | Indicator | Title | Interaction |
|-------|-----------|-------|-------------|
| `completed` | `--primary` fill, `--primary-foreground` check | `--muted-foreground`, plus "completed" for screen readers | A button when the task can go to it (`canGoTo`): `hover:bg-accent`, `rounded-md`, the shared focus ring |
| `active` | `--primary` fill, `--primary-foreground` number, 2px `--primary`/30 ring 2px out | `font-medium`, `--foreground` | None. Carries `aria-current="step"` |
| `upcoming` | 1px `--border` ring, `--muted-foreground` number | `--muted-foreground` | None |

## Usage

- **A progress list, not tabs.** The steps are taken in order, so there is no tab role and no arrow-key navigation:
  a tab that cannot be selected would announce an affordance that leads nowhere. Only a step the task can return to
  is a button.
- **Which steps can be gone to is the task's call**, not the stepper's, and only a `completed` step is ever offered.
  Capture flow offers any step it reached, back or forward, while the range is the one replayed, and none while
  something runs on the device; never Match, whose only action is to replay, which Range's Continue already is.
- Put the status of the whole task (Capture flow's "Capture paused") beside the list, not inside it.
- **`fill`** spreads the list across the width it is given: the lines between steps grow, the steps keep their size.
  Capture flow fills the dialog's width; without it the lines are 48px.

## Figma

`tapflow-product` Capture flow, the `Step Bar` of each dialog frame (Range `352:349`).
