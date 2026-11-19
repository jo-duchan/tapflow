---
component: SidebarMenuButton
source: components/ui/sidebar.tsx
cva: sidebarMenuButtonVariants
own: state
---

# SidebarMenuButton

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to SidebarMenuButton.

`components/ui/sidebar.tsx` is shadcn's Sidebar. SidebarMenuButton is one row of its menu, and the dashboard's only
call site is `AppSidebar`: every page link in the left navigation. It has one `cva` with two axes, and every call
site uses the defaults of both. `state` below is CSS and the `isActive` prop, not a `cva` axis.

Every row is rendered `asChild` as a link (`<a>`), not a `<button>`, so the global press motion does not apply
(below).

## Anatomy

```
Expanded — 256px sidebar                 Collapsed — 48px rail
┌──────────────────────────┐             ┌──────┐
│ ┌──────────────────────┐ │             │ ┌──┐ │
│ │ ▣  App Center        │ │ 32px        │ │▣ │ │  32px square
│ └──────────────────────┘ │             │ └──┘ │
│   4px                    │             │      │
│ ┌──────────────────────┐ │             │ ┌──┐ │
│ │ ▣  Flow Runs         │ │             │ │▣ │ │
│ └──────────────────────┘ │             │ └──┘ │
└──────────────────────────┘             └──────┘
  8px inset on each side, 1px border       8px inset, 1px border
```

- **Row** — 32px high (`h-8`), full width of its group: 239px in the 256px sidebar, whose 1px right border
  (`--border`) sits inside that width and which pads each group 8px (`p-2`). `rounded-md` (6px), 8px padding on every side (`p-2`), 8px between icon and label (`gap-2`). Rows in one
  group are 4px apart (`gap-1`).
- **Icon** — 16px (`[&>svg]:size-4`), never shrinks. A Lucide icon, stroke inherits the text color.
- **Label** — `text-sm` (14px) on a 20px line, regular weight, `--sidebar-foreground` inherited from the sidebar. One
  line; a long label ends in an ellipsis (`truncate` on the last `span`).
- **Groups** — expanded, a group's first row sits under its 32px label; the last row of one group and the first of
  the next are 56px apart (8px padding, 8px gap, 8px padding, 32px label). The first group has no label. The sidebar
  header above them is 48px (8px padding around a 32px logo link), and the footer pads 12px.
- **No fill at rest.** The row shows the sidebar's own `--sidebar-background` until a state paints it.

### Collapsed

The sidebar collapses to a 48px rail (`collapsible="icon"`): the page header's toggle, or ⌘B / Ctrl+B anywhere. Each row
becomes a 32px square (`!size-8 !p-2`) with the 16px icon centered; the label is still in the row but clipped by it,
so the link keeps its name. The square sits 8px from the rail's left edge and 7px from its border. The group labels (`Settings`, `Reference`) fade out and pull up, so rows within a group
stay 4px apart and groups are 24px apart. The row's tooltip shows its label on the right, with no delay — see
[tooltip.md](./tooltip.md).

The sidebar's width animates over 200ms (linear); the row's size and padding over 150ms on Tailwind's default ease (`transition-[width,height,padding]`,
`cubic-bezier(0.4, 0, 0.2, 1)`).
Each page load starts expanded: the collapsed state is written to a cookie that nothing reads.

### Below 768px

No rail and no collapse. The sidebar is a sheet from the left, 288px wide with a 1px right border (rows 271px),
opened from the page header's toggle, over a black 80% overlay. It slides in over 500ms and out over 300ms, and has no
close button: it closes from the overlay, Escape, or once a link in it is followed or the page changes (the back
gesture too). Rows are the same height. Tooltips never show there.

## Properties

### `variant`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | As the anatomy above. Adds the same hover classes the base already has, so it changes nothing | 3 |
| `outline` | `--background` fill, a 1px `--sidebar-border` ring drawn as a shadow; on hover both the fill and the ring turn `--sidebar-accent` | 0 |

### `size`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | 32px high, 14px label | 3 |
| `sm` | 28px high, 12px label | 0 |
| `lg` | 48px high, 14px label; collapsed, no padding, so its content fills the 32px square | 0 |

Call-site counts are a snapshot (2026-10-20): `AppSidebar` writes three, one per nav group, and they render up to
seven rows (App Center, Flow Runs, Mac Resources; Default, Team, Tokens; Docs) depending on the role and whether a run
exists (an Admin on a team with a run sees all seven). Draw `outline`, `sm` and `lg` only if a screen needs them.

### `state`

Light / dark values for the default variant.

| Value | Trigger | Fill | Text |
|-------|---------|------|------|
| `default` | — | None (`--sidebar-background`, `#fafafa` / `#121212`) | `--sidebar-foreground` (`#4d4d4d` / `#cccccc`), regular |
| `hover` | `hover:`, and while pressed (`active:`) | `--sidebar-accent` (`#f5f5f5` / `#212121`) | `--sidebar-accent-foreground` (`#171717` / `#fafafa`), regular |
| `focus` | `focus-visible:` | None | As `default`, with a 2px `--sidebar-ring` (link blue, `#0076f5`) ring and no offset |
| `active` | `isActive` (`data-active`) — the page you are on | `--sidebar-accent` | `--sidebar-accent-foreground`, **medium** |
| `disabled` | `disabled:` on a `<button>`, `aria-disabled:` on a link | 50% opacity, no pointer events | — |

- **`active` is the current page, not CSS `:active`.** The prop is `isActive`. Pressing a row looks like hovering it.
- **`hover` and `active` share a fill.** Only the weight tells the current page from a hovered one, and hovering
  the current page changes nothing. In light mode the fill is 2% darker than the sidebar (`#f5f5f5` on `#fafafa`);
  draw it at that value rather than darkening it to read on screen.
- **No color transition.** The fill and text switch at once; only size and padding animate.
- **Pressing does not move it.** A row is a link, so the global 1px press motion (DESIGN.md) does not apply.
- **The focus ring is the sidebar's own:** blue, no `--background` offset, flush against the row. The group's 8px
  padding leaves room for it in both widths.
- **`disabled` has no call site.** A link cannot take `disabled`; it would carry `aria-disabled`, which the same
  classes dim. That only blocks the pointer: focused, Enter still follows the link, so a disabled link would also
  need its `href` or navigation removed.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Main nav — App Center, Flow Runs, Mac Resources | `isActive` when the current path starts with the row's link (`href`) | A build's QA page (`/app-center/build`) keeps App Center current |
| Settings — Default, Team, Tokens | `isActive` only on the exact path | Team is shown to an Admin, Tokens to Admin, Developer and QA (`lib/settingsAccess.ts`) |
| Reference — Docs | Never `active`. A plain `<a>` opening tapflow.dev in a new tab | An external page has no current state here. Nothing on the row says it opens a new tab |

Flow Runs appears once the team has recorded a run, while a run page is open, or when the relay could not be asked
(see the comment in `AppSidebar.tsx`), so the main group has two or
three rows. Draw both.

## Not SidebarMenuButton

These sit in the same sidebar and look close to a row, but are hand-written:

| Where | Looks like |
|-------|------------|
| Sidebar header — team logo and name | A link: 24px logo, `text-base` (16px) semibold name in `--sidebar-accent-foreground`, 4px padding. No hover fill, no focus style of its own |
| Footer — the signed-in user | A `button` opening the account menu: 28px avatar, name (14px medium) over email (12px muted), `rounded-md`, 4px padding, `--sidebar-accent` on hover with a color transition. No focus style of its own, so it shows the browser's default outline. Collapsed, only the avatar shows, centered in the rail |
| Group labels — Settings, Reference | 32px high, `text-xs` medium, `--sidebar-foreground` at 70%. Text, not a control |

## Usage

- Use it for a page link in the sidebar: a 16px icon and a one- or two-word label. A row's label is also its
  collapsed tooltip and its accessible name, so it must make sense on its own.
- Mark at most one row `isActive`, the section the page belongs to. The AI session watch page
  (`/automation/sessions/:id`, reached only from a link) belongs to none, so no row is current there.
- Keyboard: Tab moves through the rows in order, Enter follows the link. There is no arrow-key movement.
- **The current page is shown, not told.** `isActive` sets `data-active` for the style only; the link has no
  `aria-current`, so a screen reader does not hear which page is current. That is outside the dashboard's `core`
  accessibility level (AGENTS.md), so it is not tracked in #979.

## Figma

Component set **SidebarMenuButton** (`1:2278`) on the `Navigation` page of tapflow-design-system — `variant` ×
`size` × `state`, with 5 states. The names match this spec.
