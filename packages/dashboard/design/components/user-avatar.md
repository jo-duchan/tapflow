---
component: UserAvatar
source: components/UserAvatar.tsx
cva: none
own: content
---

# UserAvatar

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to UserAvatar.

`components/UserAvatar.tsx` draws a person as a circle: their uploaded image, or else the first letter of their
name on one of six colors. It has no `cva` and is styled inline; `content` below is what renders, not a prop. It
is used in two places, both at 28px: the sidebar's account button and each comment's author.

shadcn's `components/ui/avatar.tsx` is in the package and used nowhere. Do not draw from it.

## Anatomy

```
 image          letter
  ╭──╮           ╭──╮
  │🙂│           │ J│     28px circle
  ╰──╯           ╰──╯
```

- **Circle** — 28px, fully round, never shrinks in a row. No border, no ring, no shadow.
- **Image** — the uploaded picture, cropped to fill the circle (`object-fit: cover`).
- **Letter** — the name's first character, upper-cased, centered. 42% of the size: 11.76px at 28px, semibold
  (600), Inter, on a 17.64px line. It cannot be selected. A name that does not start with a letter shows its first
  character as it is (`두`, `7`); an empty name shows `?`. A name that starts with an emoji shows a broken glyph,
  because only half of the character is taken.

## Properties

### `content`

The six colors are DESIGN.md's Avatar Palette (`--avatar-1-bg` … `--avatar-6-fg`). Light / dark values.

| Value | Fill | Letter | Letter on fill |
|-------|------|--------|----------------|
| `image` | The picture | — | — |
| `1` (rose) | `#faa8b1` / `#723139` | `#810e1c` / `#e9a5ad` | 5.61 / 4.72 |
| `2` (orange) | `#ffb885` / `#744c2f` | `#793606` / `#ebc1a2` | 5.31 / 4.50 |
| `3` (amber) | `#ffe270` / `#74662f` | `#76420a` / `#ebdda2` | 6.41 / 4.18 |
| `4` (green) | `#7de8b4` / `#2e6148` | `#09532f` / `#94dbb9` | 6.15 / 4.48 |
| `5` (blue) | `#94bdf9` / `#2f4b74` | `#0a3576` / `#a5c0e9` | 6.11 / 4.76 |
| `6` (purple) | `#deb8f5` / `#5a3371` | `#56127d` / `#cfa8e6` | 6.91 / 4.84 |

- **The color comes from the whole name, not the letter.** `avatarColors(name)` hashes the name to a slot, so
  `duchan` and `dave` share the letter D and get different colors (orange and amber), and one person keeps one color
  everywhere. An empty name is slot 1.
- The name is the person's nickname, or the part of their email before the `@` when they have none; the relay
  fills that in. A nickname of only spaces is refused since #1025. Before it, one was saved as it was and the circle
  showed no letter.
  The first account is named `Admin`; an invite link with no email names the person `User`.
- Dark slots 3 and 4 are under the 4.5:1 that 11.76px text needs; that is left to the designer's color pass, not a
  value to aim for.
- Both call sites use every value: which one shows depends only on who the person is.

## Behaviour

- **Not interactive.** No hover, focus or pressed look of its own. In the sidebar it sits inside the account
  button, which owns the hover fill.
- **An image that fails to load shows the browser's broken-image mark**, not the letter: nothing falls back. Draw
  `image` only as a loaded picture.
- The image carries the person's name as its alt text; the letter has none of its own and is read as the letter.

## Variations at the call site

| Place | Layout |
|-------|--------|
| Sidebar footer, account button | Avatar, then the name (14px medium) over the email (12px `--muted-foreground`), 10px apart, both truncated. The button has 4px padding, `rounded-md`, `--sidebar-accent` on hover, and opens the Settings / Log out menu upward. With the sidebar collapsed to its 48px icon rail only the avatar shows, centered. The button narrows to 23px, so the 28px avatar overhangs it and the hover fill shows only as 4px strips above and below it (measured) |
| Comment, QA session side panel | Avatar at the top left of the comment, 2px down from its top, 10px before the text column. The author's name (14px semibold) and the time (11px `--muted-foreground`) sit beside it on one line, then a 16px copy-link button that appears on hover or focus |

## Not UserAvatar

The avatar previews in **Settings → Profile** and on the **invite page** are drawn by hand with the same palette,
and differ from UserAvatar:

| | UserAvatar | Preview |
|-|-----------|---------|
| Size | 28px | 56px |
| Letter | 42%, semibold | 18px medium (32% of 56px) |
| Image | No border | 1px `--border` |
| Empty name | `?` on slot 1 | Settings, while the Nickname field is cleared: `?`, colored by the whole email. Invite: `?` on slot 1, though once the person joins the relay names them by the email's local part, or `User` for an invite link with no email |
| Name | The saved name | The Nickname field as it is typed, so it changes letter and color live |

The previews sit under the edit button of the image picker ([field.md](./field.md), `control` `image`). Draw them
as part of the picker, not as a size of UserAvatar.

## Usage

- Use UserAvatar wherever a person is shown, and pass their display name so the color matches everywhere else.
- Do not give it a muted fill or pick a slot by hand: the color is the name's (DESIGN.md, "Avatar Color System").
- Put the person's name next to it wherever there is room. The avatar alone does not say who it is to someone who
  does not know the color or the picture.
- Where only the avatar shows, as in the collapsed sidebar, whatever holds it still has to be named after the
  person. A picture is named by its alt text, but a letter is named by the letter alone. The account button keeps the
  name and email visually hidden (#1026); before that, a lettered avatar left it named by its initial.

## Figma

Component set **UserAvatar** (`1:2667`) on the `Data display` page of tapflow-design-system — `content` × 7, named
as in this spec, with a `Letter` property. The spec frame also draws the two call-site layouts. The picker previews
are the ImagePicker component ([field.md](./field.md)).
