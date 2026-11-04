---
component: Switch
source: components/ui/switch.tsx
cva: none
own: checked, state
---

# Switch

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Switch.

`components/ui/switch.tsx` wraps Radix Switch and has no `cva`. `checked` and `state` below are what renders, not
`cva` axes (`checked` is the Radix prop). The dashboard has one: **Full reset** in the QA session, at the right end
of the device list's filter row.

## Anatomy

```
 off                     on
┌──────────────┐        ┌──────────────┐
│ ●            │        │            ● │     track: 44 × 24px, fully rounded
└──────────────┘        └──────────────┘     thumb: 20px circle, 2px in from the edge
```

- **Track** — 44 × 24px (`h-6 w-11`), fully rounded. Its 2px border is transparent, so the fill runs to the edge and
  the thumb sits 2px inside it. `--input` when off, `--primary` when on.
- **Thumb** — a 20px circle in `--background`, with Tailwind's `shadow-lg` (not one of our elevation tokens). It
  slides 20px to the right when on, over 150ms.
- **No label of its own.** The call site puts a `Label` beside it (below).

## Properties

### `checked`

Light / dark values.

| Value | Track | Thumb | Call sites |
|-------|-------|-------|-----------:|
| `false` | `--input` (`#ebebeb` / `#2e2e2e`) | Left, `--background` (`#fafafa` / `#171717`) | 1 |
| `true` | `--primary` (`#171717` / `#fafafa`) | Right, `--background` | 1 |

In dark mode the colors swap: an on switch is a near-white track with a near-black thumb.

The off track is faint: 1.14:1 against the page in light mode, 1.32:1 in dark, and the thumb is the same against it.
That is left to the designer's color pass, not a value to aim for.

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | As above | 1 |
| `focus` | Shared ring (DESIGN.md): 2px `--ring`, 2px `--background` offset, on keyboard focus only | 1 |
| `disabled` | 50% opacity, `not-allowed` cursor | 0 — defined, never set |

- **No `hover` style.** Under the pointer only the cursor changes; at the Full reset call site the tooltip opens.
- The track is a `<button>`, so the global press motion (DESIGN.md) applies: it moves down 1px while pressed, and its
  color changes over the global 120ms (the base `button` rule outranks the switch's own `transition-colors`).

## Variations at the call site

### Full reset (QA session)

```
[ Search device… ]  [ OS ▾ ]                         Full reset  ( ●   )
```

| Part | What it is |
|------|------------|
| Label | `Full reset`, the Label component: 14px medium, `--foreground`, one line, before the switch with 8px between; clicking it flips the switch ([label.md](./label.md)) |
| Row | The group sits at the right end of the filter row (`ml-auto`), beside the search box and, when there are OS versions to filter, the OS select |
| Tooltip | Over the label and the switch together: `Keep existing data` when off, `Erase all data on the next device you pick` when on |

- **It turns itself off.** Full reset means "erase the next device I pick", once: picking a device turns it back
  off at that moment, whether or not the device then starts. Turning it on again is the only way to ask for another
  erase.
- **It is not there at all** when the selected machine's agent does not advertise full reset (the `full-reset`
  capability). It is hidden, not shown disabled. Today's iOS and Android agents both advertise it, so in practice it
  always shows; it hides only for an agent older than the feature or a third-party one.
- It starts off every time the page opens, and keeps its position when you go back to the Mac list and pick another
  Mac.

## Usage

- Use a switch for an on/off choice that takes effect without a separate confirm. Put its label before it and make
  the label click it.
- Name it by its label (`id` / `htmlFor`); the full reset switch also has a hidden description saying what it
  erases, so the warning does not live only in the tooltip.
- Keyboard: Tab reaches it, Space or Enter flips it.

## Figma

Component set **Switch** (`1:2175`) on the `Forms` page of tapflow-design-system — `checked` × `state`, 6 variants.
The names match this spec. The label, the tooltip and the row are not in the set.
