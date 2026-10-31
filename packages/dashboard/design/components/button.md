---
component: Button
source: components/ui/button.tsx
cva: buttonVariants
own: state
---

# Button

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Button.

`variant` and `size` below are the keys of `buttonVariants` in `components/ui/button.tsx`, which is the
source of truth. `scripts/__tests__/designSpecMatchesCva.test.mjs` fails when the two disagree.

## Anatomy

```
┌──────────────────────────┐
│  [icon]  Label  [icon]   │   gap 8px · icons 16px · text-sm font-medium
└──────────────────────────┘
```

- **Container** — `rounded-md` (6px), except `pill`. Height comes from `size`.
- **Label** — `text-sm font-medium`, single line (`whitespace-nowrap`). `nav` drops to `text-xs`.
- **Icon** (optional, leading or trailing) — always 16px, never takes pointer events.
- **Focus ring** — drawn outside the container and never changes its size. See DESIGN.md → States.

## Properties

### `variant`

| Value | Surface / text | Call sites | Use |
|-------|----------------|-----------:|-----|
| `default` | `--primary` / `--primary-foreground` | most (it is the default) | Primary action — one per view |
| `destructive` | `--destructive` at 10% / `--destructive` | 5 | Delete, leave, revoke |
| `outline` | `--background` + 1px `--input` border / `--foreground` | 16 | Secondary action |
| `secondary` | `--secondary` / `--secondary-foreground` | 1 | Tertiary action |
| `ghost` | transparent / `--foreground` | 20 | Icon buttons, inline actions in lists and toolbars |
| `link` | transparent / `--primary` | 0 | Defined, not used yet |

`destructive` is a **soft tint**, not a solid red fill. This is a local choice — upstream shadcn uses a solid
fill — and follows from the monochrome-first rule: no saturated surface in the UI. In dark mode
`--destructive` is raised to L 62%: it has to stay at L ≥ 60% for both the 10% tint and the text to stay legible.

### `size`

| Value | Height | Padding (x) | Call sites | Use |
|-------|-------:|------------:|-----------:|-----|
| `default` | 40px | 16px | — | General buttons |
| `sm` | 36px | 12px | 24 | Form submit, inline actions in a list |
| `lg` | 44px | 32px | 2 | Auth form submit (Login, Setup) |
| `icon-sm` | 36×36 | — | 3 | Square icon button next to `sm` controls |
| `icon` | 40×40 | — | 19 | Square icon button |
| `pill` | 48px, `rounded-pill` (100px) | 24px | 0 | Marketing-scale CTA — defined, not used yet |
| `nav` | 28px, `text-xs` | 12px | 2 | Table-inline and navigation actions |

Call-site counts are a snapshot (2026-10-17) to show what is common, not a contract.

### `state`

Button has the four shared states. The table gives the tokens per `variant`; focus and disabled are
the same for every variant and are defined once in DESIGN.md.

| variant | `default` | `hover` | `focus` | `disabled` |
|---------|-----------|---------|---------|------------|
| `default` | `--primary` | `--primary` at 90% (Figma `Primary/Hover`) | shared ring | 50% opacity |
| `destructive` | `--destructive` at 10% (Figma `Destructive/Subtle`) | `--destructive` at 20% (Figma `Destructive/Subtle Hover`) | shared ring | 50% opacity |
| `outline` | `--background`, border `--input` | `--accent`, text `--accent-foreground` | shared ring | 50% opacity |
| `secondary` | `--secondary` | `--secondary` at 80% (Figma `Secondary/Hover`) | shared ring | 50% opacity |
| `ghost` | transparent | `--accent`, text `--accent-foreground` | shared ring | 50% opacity |
| `link` | transparent | underline, offset 4px | shared ring | 50% opacity |

**Pressed is motion, not a state.** A Button that is not `disabled` moves down 1px while pressed
(`translateY(1px)`, 120ms) and its colors do not change, so there is no `pressed` variant to draw. The rule
is global in `src/index.css`. It skips any trigger that opens an overlay (`aria-haspopup` — DropdownMenu, Dialog
and AlertDialog triggers, so "Upload build" does not move), because the shift glitches when the overlay opens, and a Button rendered `asChild` as a link, which is not a `<button>`.

Only `disabled:` is styled. A button that is busy but must keep focus uses `aria-disabled` and dims itself
with `aria-disabled:` classes at the call site, because a focused element that becomes `disabled` loses
focus. It has the same 50% opacity as `disabled`, but it still shows `hover` and still moves when pressed:
nothing removes its pointer events.

Button has no `selected`, `loading` or `error` state in code. Do not draw one; if a screen needs it,
propose it as a code change first.

## Usage

| Context | variant | size |
|---------|---------|------|
| Auth form submit (Login, Setup) | `default` | `lg`, full width |
| Settings form submit | `default` | `sm` |
| Inline action within a list | `ghost` or `outline` | `sm` |
| Table-inline / navigation action | `ghost` or `outline` | `nav` |
| Icon-only action | `ghost` | `icon` or `icon-sm` |
| Confirm in a destructive AlertDialog | `destructive` | `default` |

- Use one `default` button per view. A second primary action is a `outline` or `secondary`.
- An icon-only button needs an accessible name (`aria-label`) — the icon alone is not one.

## Figma

Component set **Button** (`29:422`) in the `Design System` page — one variant for every `variant` × `size` × `state`.
It is one set on purpose: `destructive` is a value of the `variant` prop, not a separate component, so a
separate "Button Danger" set would stop mapping 1:1 to code.
