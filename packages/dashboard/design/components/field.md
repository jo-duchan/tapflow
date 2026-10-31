---
component: Field
source: components/ui/field-error.tsx
cva: none
own: control, hint, message
---

# Field

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Field.

**There is no `Field` component in code.** A field is written out at each call site: a `div.grid.gap-2` holding a
[Label](./label.md), one control, and the line under it. Two small components draw that line:
`components/ui/field-hint.tsx` (`FieldHint`) and `components/ui/field-error.tsx` (`FieldError`). `control`,
`hint` and `message` below are what the call sites render, not props. Draw the assembly as one component, because
every form in the dashboard is a stack of them: 32 fields in 10 files.

shadcn's `components/ui/form.tsx` (`FormItem`, `FormLabel`, `FormMessage`) is in the package and used nowhere.
Do not draw from it: its error label turns red and its message is medium weight, and neither happens here.

## Anatomy

```
Password                              label: 14px medium, one line (14px high)
                                      8px
┌──────────────────────────────────┐
│ ••••••••                         │  control: Input, 40px high
└──────────────────────────────────┘
                                      8px
Use at least 8 characters             line: hint or message, 14px on a 20px line
```

- **Stack** — label, control, line, 8px apart (`gap-2`), full width of the form. Measured: 62px without a line, 90px
  with one.
- **Label** — [label.md](./label.md): 14px medium, `--foreground`, with an optional inline hint in parentheses.
- **Control** — one of the five under `control`.
- **Line** (optional) — a hint (`--muted-foreground`) or a message (`--destructive`, or amber for the one warning),
  14px regular on a 20px line. It wraps rather than truncating.
- **The error slot takes no space while it is empty.** `FieldError` is always in the page, so an error is announced
  into a region that already existed, but while it has no text it is `absolute` and the field is 62px, as if it
  were not there. Do not draw a reserved blank line.
- **Nothing else changes on an error.** The label stays `--foreground`, and the control keeps its border and fill:
  no red border, no icon (DESIGN.md, "Error does not change a control").

## Properties

### `control`

| Value | What it is | Call sites |
|-------|------------|-----------:|
| `input` | [Input](./input.md), 40px | 21 |
| `select` | [Select](./select.md) trigger, 40px | 5 |
| `slider` | Slider, with its current value at the right end of the label row (below) | 2 |
| `image` | Image picker: a preview with a 24px round edit button on its corner (below) | 3 |
| `file` | File drop zone, 96px (below) | 1 |

**Slider** (Flow run videos, Settings). The label row puts the label on the left and the value on the right
(`3 days`, `20 GB`), 14px regular, figures at fixed width, on one baseline. The gaps are 12px, not 8px
(`gap-3`). Track: 6px high, fully rounded, `--muted` (`#f5f5f5` / `#262626`), filled with `--primary` up to the
thumb. Thumb: a 16px white circle in both themes (`bg-white`, not a token), 1px `--primary` border, Tailwind
`shadow-sm`. On hover and on keyboard focus a 4px `--ring` halo at 50% appears around the thumb, in place of the
shared ring.

**Image picker** (avatar and logo, Settings and the invite page). The preview is the control's face, and the edit
button is the part you press.

| Picker | Preview | Without an image |
|--------|---------|------------------|
| Workspace logo | 64px, `rounded-lg` (8px), the image fitted inside it | The default tapflow logo |
| Avatar (Settings, invite) | 56px circle, 1px `--border`, the image cropped to fill | The initial on its avatar color, 18px medium |

The edit button sits on the preview's bottom-right corner: 24px circle, `--background` fill, 1px `--border`,
`shadow-sm`, a 12px pencil. On hover the fill turns `--accent`. Choosing an image swaps the preview at once; it is
saved with the form.

**File drop zone** (Upload build). 96px high, full width, `rounded-md`, a 2px dashed `--border`, centered text
14px `--muted-foreground`: `Click or drag to upload`, replaced by the chosen file's name once one is picked. On hover the border turns
`--primary`. Click or drop a file on it.

### `hint`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `none` | Label and control only | 20 |
| `inline` | In the label, after the name: `(optional)`, `(png · jpg, max 2MB)`. 12px `--muted-foreground` ([label.md](./label.md)). Upload build's `(optional)` is 14px, a code inconsistency: draw 12px | 5 |
| `below` | `FieldHint` under the control, 14px `--muted-foreground` | 7 |

- The `below` hints: the password rule (`Use at least 8 characters`) on four new-password fields, and a sentence
  under each of the two sliders. The seventh is the file drop zone's line (`iOS: .app.zip or .tar.gz / .tgz … ·
  Android: .apk`), written by hand at 12px rather than with `FieldHint`. Treat 14px as the rule.
- No field has both an inline and a below hint.
- Hint text on `--card` is 3.59:1 in light mode and 7.0:1 in dark (3.44:1 and 7.36:1 on `--background`, the
  dialog fill). Light mode is under the 4.5:1 that 14px text needs; that is left to the designer's color pass, not a
  value to aim for.

### `message`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `none` | No line. Either the slot is empty or the field has none | 32 — every field at rest |
| `error` | `FieldError`: 14px regular `--destructive` (`#f00000` / `#e25a5a`) | 19 — one cannot fire (below) |
| `warning` | 14px regular, Tailwind amber (`#b45309` / `#fcd34d`), not a token | 1 |

- **`error` replaces a `below` hint**, in the same place and size, so the field keeps its 90px. Only the
  new-password fields have both, and their error says the rule itself (`Password must be at least 8 characters`).
  On a field without a hint the error adds a line, and what is under the field moves down 28px.
- **13 fields have no error slot**: the Add App dialog's three, Upload build's two, the sliders, the Settings logo
  and avatar, the token's Expiration and Type, the invite page's Nickname, and the Edit app dialog's App name. Their failures
  are said elsewhere: in a form message (below), a toast, or the browser's own required-field bubble (Add App's
  Name and Bundle ID, not drawn). The Settings logo and avatar reject a file over 2MB with
  the toast `Image must be 2MB or less`, while the invite page's avatar says `Max 2MB for avatar` under the field.
- The invite dialog's Role field has a slot, but its Select starts on `QA` and has no empty choice, so it never
  shows an error.
- **`warning`** is on the token's Expiration field when `No expiration` is picked: `A token without an expiry stays
  valid until you revoke it. For CI, 90 days or less is recommended.` It is advice, not a refusal, and the form
  still submits.
- Error text on `--card` is 4.46:1 in light mode and 4.74:1 in dark (4.28:1 and 4.99:1 on `--background`). Warning
  is 5.02:1 and 11.82:1 on `--card`. The light error is under 4.5:1; that is left to the designer's color pass, not
  a value to aim for.

Call-site counts are a snapshot (2026-10-21).

## Behaviour

- **Errors appear on submit, not while typing.** A refused submit shows every invalid field's error at once and
  moves focus to the first invalid field, so that field shows its focus ring beside its error. After that, each
  field checks itself as it changes: its error goes away as soon as the value is valid, and a password field's hint
  comes back.
- **Two exceptions.** The invite page's avatar shows `Max 2MB for avatar` the moment a file that is too large is
  picked, before any submit. The Add App dialog does not check its fields itself: an empty Name or Bundle ID is
  refused by the browser's required-field bubble, which is not drawn.
- **The submit button does not wait for valid fields.** It is enabled, and pressing it is what shows the errors. It
  is disabled only while the form is sending. Upload build is the exception: its Upload button stays disabled until
  a file is chosen.

## Variations at the call site

### Spacing in a form

| Form | Between fields | Label to control |
|------|----------------|------------------|
| Sign-in, setup, password reset, invite page, Settings, Team, Tokens and Upload build dialogs | 16px (`gap-4`) | 8px |
| Add App dialog | 16px | **6px** (`gap-1.5`) |
| Flow run videos | 24px (`gap-6`) | 12px (slider) |
| Edit app dialog (Settings → Apps) | One field | 8px |

The Add App dialog's 6px is a code inconsistency, not a second size. Draw 8px.

Three forms split their fields with a 1px `--border` Separator, 16px on each side: Settings → Workspace (between
Team name and Logo), Settings → Profile (between Nickname and Avatar), and the invite page (between Avatar and the
password fields).

### Form message

A form whose submit the relay can refuse has one more `FieldError` after its last field, before the submit button:
the relay's own message (`Invalid email or password`, `Network error. Please try again.`). It looks the same as a
field's error, full width, and takes no space until it has text. Then it sits 16px below the last field and 16px
above the button (20px on sign-in and setup, whose button adds `mt-1`; a code inconsistency, draw 16px). It is on the sign-in, setup, password reset, invite and change-password forms, and in the Add App
dialog. On the invite page, when the email is already a member, a `Go to sign in` link follows it, 14px, centered,
underlined.

## Not Field

- **A read-only value to copy** (the invite link, the password-reset link, a new token, the agent command, Setup's `tapflow admin init`): a sentence in 14px
  `--muted-foreground` names a read-only Input in 14px monospace below it ([input.md](./input.md)). It is not a
  `Label`, takes no hint or message, and is drawn with the Input.
- **Full reset** in the QA session: a Label beside a [Switch](./switch.md), in a row, not stacked.
- **The token's Scope line**: 12px `--muted-foreground` text with a Badge, under the Type field, describing the
  choice rather than a field of its own.

## Usage

- Every field has a visible `Label`. Name the control with `htmlFor`; a control that is not one labellable element
  (a slider, a picker) is named with `aria-labelledby` or carries its own `aria-label`.
- Put a standing rule in a `below` hint, and say the same rule in the error when it is broken, so the swap reads as
  the hint turning red.
- Write the error as what to do: `Enter a valid email`, `Give the token a name`, `Must be between 1 and 365`.
- A field's error is its control's description (`aria-describedby`) and the control is marked `aria-invalid`.
  Nothing styles `aria-invalid`.

## Figma

Component set **Field** (`75:335`) in the `Design System` page — `control` × `hint` × `message`, 12 variants
(3 × 2 × 2). It was made before `FieldHint` existed, so its `hint` axis likely means the inline hint only. The value
names were not checked against this spec, and it has no slider, image picker, file drop zone or warning. Matching
it is one of the items for the Figma sync.
