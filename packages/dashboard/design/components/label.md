---
component: Label
source: components/ui/label.tsx
cva: none
own: hint
---

# Label

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Label.

`labelVariants` in `components/ui/label.tsx` is a `cva` with a base class and no variants, so Label has
no prop axes. `hint` below is a pattern written at the call site, not a prop.

## Anatomy

```
Email
Logo (png · jpg, max 2MB)
└──┘ └──────────────────┘
text      hint (optional)
```

- **Text** — `text-sm font-medium leading-none`, `--foreground`. Single line.
- **Hint** (optional) — an inline `<span>` inside the label, after one space: `text-xs`, `--muted-foreground`,
  in parentheses. It sits on the same line as the text.

A standing instruction *under* the control is not part of Label. It is `FieldHint`
(`components/ui/field-hint.tsx`, `text-sm --muted-foreground`, 6 call sites) and belongs to the Field assembly —
see [field.md](./field.md).

Label is not interactive. It has no `hover`, `focus` or `disabled` look of its own; clicking it moves focus to
the control it names (`htmlFor`).

## Properties

### `hint`

| Value | Looks like | Call sites | Use |
|-------|------------|-----------:|-----|
| `none` | Text only | 28 | Almost every field |
| `inline` | Text + `(…)` in `text-xs --muted-foreground` | 5 | Optional fields, file constraints (`png · jpg, max 2MB`) |

Call-site counts are a snapshot (2026-10-17). One of the five, `Status (optional)` in `UploadBuildDialog`,
leaves out `text-xs`, so its hint renders at `text-sm`. Treat `text-xs` as the rule; the outlier is a code
inconsistency, not a second size.

## No disabled state

The base class carries `peer-disabled:opacity-70` and `peer-disabled:cursor-not-allowed`, which apply when a
**preceding** sibling with the `peer` class is disabled. No call site has that shape: the only control with `peer` is `Switch`, and its one
labelled use (Full reset, `src/pages/QASession.tsx`) puts the Label before the Switch. So the 70% never
renders. Do not draw a disabled Label; a disabled field is shown by its control alone.

## Usage

- Every visible field label is a `Label`. Name the control with `htmlFor`, which makes clicking the label
  focus the control.
- A label for something that is not a single labellable control (an avatar picker, a slider group) has no
  `htmlFor`. Give it an `id` and point the control at it with `aria-labelledby`, as `VideoStorageCard` does.
  A label with neither names nothing. That is fine when the control carries its own name — the avatar and logo
  pickers' buttons have `aria-label` ("Change avatar"), so their Label is a visible heading only. It is a gap
  when the control has no other name. `UploadBuildDialog` associates File with its picker button and Status
  with its select trigger.
- Above a control the label sits in the field assembly: `Label` + control + `FieldHint` or error, `gap-2` (28 of
  33). The outliers are `AddAppDialog` (`gap-1.5`, 3) and `VideoStorageCard` (`gap-3`, 2, where the label shares
  a row with the slider's value). See [field.md](./field.md).
- Do not restyle the text per screen. The one override in code (`text-sm cursor-pointer whitespace-nowrap`
  on Full reset) keeps the same size and only stops the toolbar label wrapping.

## Figma

Component set **Label** (`1:2635`) on the `Forms` page of tapflow-design-system — `hint` × 2, named as in this spec.
There is no disabled variant.
