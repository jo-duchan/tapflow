---
component: DropdownMenuItem
source: components/ui/dropdown-menu.tsx
cva: none
own: state
---

# DropdownMenuItem

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to DropdownMenuItem.

`components/ui/dropdown-menu.tsx` wraps Radix DropdownMenu and has no `cva`. This spec covers the item and the
content panel and separator around it; `state` below is what renders, not a prop. The dashboard has four dropdown
menus: the account menu in the sidebar footer, with Settings and Log out; each app's menu in Settings → Apps, with
Edit and Delete; each device card's menu in the QA session picker (Admin only), with Rename and Hide or Show; and each
build row's menu in App Center, with Edit build and Schedule deletion or Cancel scheduled deletion.

## Anatomy

The account menu, drawn below; the app menu differs only where [The app menu](#the-app-menu) says.

```
┌──────────────────────────────┐   content: 224px, --popover, 1px --border, rounded-md, shadow-md, 4px padding
│ ⚙   Settings                 │   item: 32px, rounded-sm
│ ──────────────────────────── │   separator: 1px --muted, 4px above and below, edge to edge
│ ⇥   Log out                  │   destructive text
└──────────────────────────────┘
        4px
[ avatar  Ann                  ]   trigger: the sidebar footer's user button
```

- **Content** — 224px wide in the account menu (`w-56`, set at the call site; the base minimum is 128px). `--popover` fill (`#ffffff`
  / `#1c1c1c`), `--popover-foreground` text, 1px `--border`, `rounded-md` (6px), Tailwind `shadow-md`, 4px padding
  (`p-1`). The account menu opens above the trigger (`side="top"`), aligned to its left edge, 4px from it
  (`sideOffset`). Radix flips it below when there is no room above.
- **Item** — 32px high: `text-sm` (14px) regular on a 20px line, 6px top and bottom, 8px sides (`px-2 py-1.5`).
  `rounded-sm` (4px). 214px wide inside the account menu's 224px panel. The pointer stays an arrow (`cursor-default`), and the text
  cannot be selected.
- **Icon** — account menu only. 16px (`[&_svg]:size-4`), before the label. **16px from the label, not 8px:** the
  item puts 8px between its children (`gap-2`) and both account items add `mr-2` to the icon on top of it. Draw the
  16px that ships.
- **Separator** — 1px of `--muted` across the full panel width (`-mx-1` cancels the padding), 4px above and below
  (`my-1`). On the white panel it is very faint (`#f5f5f5` on `#ffffff`); draw it at that value.
- **Motion** — opens in 150ms: fades in, scales from 95% and slides 8px up from the trigger's side. Closes with a fade
  and scale back to 95%. With reduced motion the panel opens and closes at once; the item's 150ms color transition
  stays.

The whole account menu is 83px high: 1px border and 4px padding at each end, two 32px items and a 9px separator.
The app menu is the same height.

### The app menu

Each app's menu in Settings → Apps, with Edit and Delete.

- **Content** — 160px wide (`w-40`). Opens below the trigger (the default side), aligned to its right edge
  (`align="end"`), 4px from it. Radix flips it above when there is no room below. Items are 150px wide.
- **Items** — text only, no icon. Edit, a separator, then Delete.
- **Trigger** — a `ghost` icon Button, 32px square (`size="icon-sm"` narrowed with `h-8 w-8`), holding a 16px
  `Ellipsis`. Named `Actions for <app name>`. In arrange mode it is `invisible`: it keeps its place so the header does
  not shift, and cannot be reached.

The device card's and the build row's menus follow it, with two differences.

- **Device card** — named `Actions for <name shown>`; both items are plain (Hide is undone from the same menu).
- **Build row** — 208px wide (`w-52`), the trigger 36px (`size="icon-sm"` unnarrowed, to match the row's status
  Select). Last on the row, after Start QA, as the app and device cards put theirs. Named `Actions for <buildRowName>`. **Its destructive item depends on the build's state**: Schedule
  deletion is destructive and comes last after a separator; once a deletion is scheduled the same slot holds Cancel
  scheduled deletion, which undoes and so is a plain item. Every item opens a dialog or acts at once, and a dialog
  opened from an item returns focus to the trigger itself (`onCloseAutoFocus`).

### The trigger

The sidebar footer's user button: a 28px avatar, then the name (14px medium) over the email (12px muted),
`rounded-md`, 4px padding, `--sidebar-accent` on hover. It has no open style: while the menu is open it shows the
hover fill only while the mouse is on it. Its focus is the browser's default outline, not the shared ring.

In the collapsed sidebar the trigger is the avatar alone (the photo, or the initial on its color when there is
none), centered in the 48px rail, and the 224px menu opens from the rail's left edge over the page beside it. Draw
that frame too, with both avatars. Without a photo the trigger is then named only by the initial (tracked in #979).

## Properties

### `state`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `default` | No fill, `--popover-foreground` text (or the call site's color) | 4 |
| `focus` | `--accent` fill (`#f5f5f5` / `#262626`), `--accent-foreground` text; 150ms color transition. A destructive item takes the red tint instead (below) | 4 |
| `disabled` | 50% opacity, no pointer events (`data-disabled`) | 0 — defined, no item is disabled |

- **`focus` is also hover.** Radix moves focus to the item under the mouse and back to the panel when the mouse
  leaves, so the mouse and the arrow keys light the same item the same way. There is no separate `hover`.
- **No focus ring.** The fill is the only focus indicator (`outline-none`); the shared ring is not drawn on an item.
  It is faint: 1.09:1 against the panel in light mode, 1.13:1 in dark.
- **Pressing does not move it.** An item is `role="menuitem"`, which the global press motion (DESIGN.md) does not
  match. The trigger has `aria-haspopup="menu"` and does not move either.
- The `--accent` fill is the separator's color too (`--muted` and `--accent` share a value): `#f5f5f5` on `#ffffff`,
  `#262626` on `#1c1c1c`.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Settings | `asChild`, rendered as a link to Settings → Default | Navigation; the menu closes and the page changes. In the mobile sheet it also closes the sheet |
| Log out | `text-destructive focus:bg-destructive/10 focus:text-destructive` | Red text (`--destructive`, about `#f00000` / `#e25a5a`), and when focused the destructive Button's tint instead of the `--accent` fill: `--destructive` at 10%. At 14px it is just under 4.5:1 (4.47 at rest, 3.75 focused in light; 4.75 and 4.24 in dark). Signs out and goes to the sign-in page, with no pending look while it waits |
| Delete (Settings → Apps) | Same as Log out | Opens the delete confirmation for that app |

## Usage

- Use it for a short list of actions behind one trigger. Each item is an icon and a one- or two-word label.
- Put the destructive item last, after a separator. Its text is red, and its focus fill is the red tint.
- Keyboard: Enter, Space or ↓ on the trigger opens the menu with focus on the first item; pressing it with the mouse
  opens it with focus on the panel. ↑ ↓ move between items and stop at the ends, Home and End jump, typing a letter jumps to the item
  that starts with it. Enter or Space chooses. Escape closes, and focus goes back to the trigger.
- The menu is modal while open: the rest of the page is hidden from assistive technology, ignores the pointer and
  does not scroll. A press outside only closes the menu; it does not reach what is under it.

## Figma

Component set **DropdownMenuItem** in the `Design System` page — `state` × 3. The value names were not checked
against this spec. The content panel, the separator and the destructive item's red text and tint are not in the set; draw them from the
anatomy and the table above.
