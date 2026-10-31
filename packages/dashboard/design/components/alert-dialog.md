---
component: AlertDialog
source: components/ui/alert-dialog.tsx
cva: none
own: action
---

# AlertDialog

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to AlertDialog. The panel, overlay, width and motion are Dialog's: see
> [dialog.md](./dialog.md).

`components/ui/alert-dialog.tsx` wraps Radix AlertDialog and has no `cva`. It asks one question before an action
that is destructive or hard to undo. `action` below is how the call site styles its confirm button, not a prop.

## Anatomy

```
┌───────────────────────────────────────────┐
│ Remove this member?                       │   AlertDialogHeader
│ This member will lose access to the team  │     8px between (space-y-2)
│ immediately.                              │
│                                           │   16px (gap-4)
│                       [ Cancel ] [Remove] │   AlertDialogFooter, 8px apart
└───────────────────────────────────────────┘
  24px padding on every side, 512px wide
```

- **Overlay and panel** — as Dialog: black at 80%, `--background` panel, 1px `--border`, `rounded-lg` (8px),
  `shadow-lg`, 24px padding, 16px between children, centered, 150ms fade and scale (instant with reduced
  motion). Every call site uses the base width, `max-w-lg` (512px); none overrides it.
- **Title** — `text-lg` (18px) `font-semibold` on its normal 28px line, `--foreground`. Not Dialog's
  `leading-none tracking-tight`, so it is taller and slightly wider. Phrased as a question ending in `?`.
- **Description** — `text-sm`, `--muted-foreground`. On every call site: one or two sentences saying what is lost.
  The app deletion bolds the app's name (`<strong>`, in `--muted-foreground` too).
- **Footer** — right-aligned, Cancel then the action, 8px apart (`sm:space-x-2`). **Below 640px** the action
  goes on top and both stretch to the panel's width, 8px apart (Cancel's `mt-2`).
- **Cancel** — `Button` `outline` at the default 40px. Always present, always first.
- **The trigger does not move on press.** Radix gives `AlertDialogTrigger` `aria-haspopup="dialog"`, which the
  global press motion excludes (DESIGN.md).
- **No Close (✕).** The dialog closes through Cancel, Escape or the action. A click on the overlay does nothing.

## Properties

### `action`

| Value | Looks like | Call sites | Where |
|-------|------------|-----------:|-------|
| `primary` | `Button` `default` — ink fill, white text | 3 | Schedule deletion (build row's ⋯ menu), Restart this device (toolbar), Start again (a session link to a device that has shut down) |
| `destructive` | `Button` `destructive` — the soft tint: `--destructive` at 10% fill (20% on hover), `--destructive` text, no border | 5 | Revoke token, Delete app (96px, `w-24`), Remove member, Take over (a device a teammate is coming back to), Merge (a bundle ID moved into another app) |

Call-site counts are a snapshot (2026-10-30). Each button keeps its own `Button` states (hover, focus, pressed);
see [button.md](./button.md). `destructive` is not a solid red fill anywhere in the dashboard.

All five look the same; only Delete app differs, by its fixed 96px width. Take over and Merge pass
`buttonVariants({ variant: 'destructive' })` as their class, so they follow the variant. Remove member gets there by
writing the variant's classes out by hand (`bg-destructive/10 text-destructive hover:bg-destructive/20 border-0`)
instead of passing `variant="destructive"`, so it would not follow a change to the variant.

`primary` is for an action that can be undone or does not reach beyond what is under test: a scheduled deletion
can be cancelled for 7 days, and a restart loses the screen and the app under test's data, not other apps'.

There is no state axis: the panel is not interactive.

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Delete app (Settings → Apps) | Both buttons `w-24` (96px) | Equal-width pair. Below 640px they keep 96px instead of stretching, stacked at the left edge |
| Revoke token | The action is a plain `Button`, not `AlertDialogAction` | It waits for the revoke and closes only when it succeeds; a failure leaves the dialog open with a toast. There is no pending look: the label and enabled state do not change while it waits |
| Merge (Settings → Apps, arrange mode) | The action is a plain `Button` with `aria-disabled` while it waits; a `role="status"` line between the description and the footer | Waits for the relay like Revoke, then for the app list that shows the row moved, and says a refusal inside the dialog (a toast is hidden while it is open). Behind it the dropped row shows landed in the target, which takes the `ring-2` drop ring, and fades to 40% where it still is. Opened by a drop, not a trigger, so `onCloseAutoFocus` puts focus back itself: on the kept app's ⋯ menu after a merge (two apps becoming one removes the mode button), else on the row that was dropped. The busy action reads `Merging…` and dims with `aria-disabled:` classes |

## Usage

- Use AlertDialog to confirm something destructive or hard to undo. For a task — a form, a value to copy — use
  Dialog.
- Title: the action as a question (`Revoke token?`, `Restart this device?`). Description: what is lost, in plain
  words; "this cannot be undone" alone does not tell anyone what they would lose. Action label: the verb from the
  title (`Revoke`, `Restart`), never `OK` or `Yes`.
- Focus starts on Cancel, so Enter right after it opens does not confirm.
- **Open it from an `AlertDialogTrigger`, or return focus yourself.** As with Dialog, Radix puts focus back only on
  a trigger. The build row's deletion dialog, opened from its ⋯ menu, passes `onCloseAutoFocus` to the ⋯. Revoke token, Remove member and Restart
  this device do neither, so focus drops to the page when they close. Delete app has a trigger, but confirming
  disables it (`Deleting…`) before focus comes back, so focus drops there too; Cancel and Escape return it. All
  four are tracked in #979.

## Figma

A single component **AlertDialog** (`85:468`) in the `Design System` page, with no variants. The two `action`
looks above are not in it; adding them as an axis is one of the items for the Figma sync.
