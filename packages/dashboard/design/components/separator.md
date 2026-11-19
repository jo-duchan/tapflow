---
component: Separator
source: components/ui/separator.tsx
cva: none
own: orientation
---

# Separator

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Separator.

`components/ui/separator.tsx` wraps Radix Separator and has no `cva`. `orientation` is a real prop
(`horizontal` by default); the length and the space around the line come from the call site.

## Anatomy

```
horizontal                         vertical
────────────────────────────       Label  │  Label
1px high, full width                      1px wide, height set at the call site
```

- **Line** — 1px, `--border` fill (`bg-border`), no radius, no margin of its own. `shrink-0`, so a flex row or
  column never squeezes it away.
- **Space around it** — none from the component. Every call site takes it from the parent's `gap`, so the line
  sits the same distance from what is on either side.

It has no states: it is not interactive and never takes focus. All nine call sites render it decorative
(`role="none"`), so a screen reader skips it.

## Properties

### `orientation`

| Value | Looks like | Call sites | Where |
|-------|------------|-----------:|-------|
| `horizontal` | 1px high, full width of its container | 3 | Between the profile fields and the password on Invite; between the name and the image in Settings → Workspace and Settings → Profile |
| `vertical` | 1px wide, height from the call site | 6 | App header (×2), the uploader and date in a build row, the fps and stream mode in the device info card, the side panel of a QA session and of an AI session |

Call-site counts are a snapshot (2026-10-18). The base height of `vertical` is `h-full`, and no call site uses
it as is: each one sets a height (below).

## Variations at the call site

These are `className` overrides, not props.

| Where | Length | Space on each side | Why |
|-------|--------|--------------------|-----|
| Form fields (Invite, Workspace, Profile) | Full width | 16px (`gap-4` of the form) | Splits a form into two parts without a heading |
| App header — after the sidebar toggle, and between the theme toggle and the GitHub link | 16px (`h-4`) | 8px (`gap-2`) | Sets off the sidebar toggle from the breadcrumb, and the GitHub link from the theme toggle, in a 64px bar |
| Build row meta line — uploader \| date | 12px (`h-3`) | 14px | Between two pieces of `text-xs` metadata |
| Device info card — fps \| mode | 12px (`h-3`) | 12px | Same, beside 11–12px text |
| QA session, AI session — content \| side panel | Full height of the row (`h-auto`, stretched by the flex row) | 24px (`gap-6`) | Divides the page into two columns |

On the AI session page the line shows only from 1024px up (`hidden lg:block`). Below that the panel stacks
under the content and there is no line between them, only the 24px gap.

The short lines — header, build row, info card — are about as tall as the text beside them (12px beside 12px
text) and half the height of the buttons beside them (16px beside the header's 32px buttons); they stop short of
the row's edges. The two-column dividers on the QA and AI session pages are the exception and run the row's full
height. The 14px
and 12px gaps in the build row and the info card are off the 4px/8px scale as written; draw them as they are,
not rounded.

## Lines that are not Separator

These look the same (1px `--border`) but are drawn by hand. Draw them with the same line; they are listed so the
Figma file does not grow a second divider.

| Where | How | Notes |
|-------|-----|-------|
| Edges of layout regions — header bottom, App Center and Macs sidebars, build rows, release panels, the Settings list | `border-b`, `border-r`, `border-t`, `divide-y` | A border on the region, not an element between two things |
| App Center sidebar, above Add App | `border-t` with 4px above and below (`mt-1 pt-1`) | Splits the app list from its action |
| Device toolbar, between groups | `div` with `role="separator"`, 16px wide (`w-4`), 6px above and below (`my-1` plus the toolbar's `gap-0.5`) | Not decorative: it separates the button groups for a screen reader |
| Comment panel date divider | Two `h-px` lines, 12px from a centered 11px date label, 12px above and below | `── Today ──` |
| Error page — code \| message | `w-px` at 24px, `aria-hidden`, 16px each side | |
| AI session activity list | `border-l`, with the steps 16px to its right | A rail, not a divider |

## Usage

- Use it between two parts of the same surface: groups of fields in one card, groups of controls in one bar,
  two pieces of metadata in one line. Between two cards, use the gap; the cards have their own borders.
- Leave the spacing to the parent's `gap`. Do not add margin to the line.
- Leave it decorative unless it separates groups a keyboard or screen reader user moves through, like the
  device toolbar. Then pass `decorative={false}`: Radix adds `role="separator"`, plus `aria-orientation="vertical"` on a vertical
  line (horizontal is the default and is left implied).
- `SidebarSeparator` (`--sidebar-border`, 8px side margin) is exported and used nowhere. `DropdownMenuSeparator`
  and `SelectSeparator` belong to their menus and are covered by those specs.

## Figma

Component set **Separator** (`1:2564`) on the `Data display` page of tapflow-design-system — `orientation` × 2. The
names match this spec.
