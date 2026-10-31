---
component: Badge
source: components/ui/badge.tsx
cva: badgeVariants
---

# Badge

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Badge.

`components/ui/badge.tsx` has one `cva` with two axes. `variant` is the shadcn set, drawn from tokens. `tone` is
ours: the QA status and the platform, drawn from Tailwind's palette. A call site passes one or the other, never
both with a look of its own (see [How the two axes combine](#how-the-two-axes-combine)).

## Anatomy

```
╭──────────────╮
│ In Progress  │   22px high: 12px text on a 16px line, 2px top and bottom, 1px border
╰──────────────╯
 ↑ 10px    10px ↑
```

- **Box** — `rounded-full` (a pill at any width), 1px border, 10px side padding, 2px top and bottom
  (`px-2.5 py-0.5`). Inline: as wide as its text, never stretched. It is a `div`, so it cannot sit inside a `<p>`.
- **Text** — `text-xs` (12px) `font-semibold`, one line. No icon slot; the one Badge holding something other than
  text is the Runs filter chip (below).

It has no states. It is not interactive: no `hover`, no `focus`, no `disabled` (DESIGN.md). `transition-colors` is
in the base class but nothing changes color.

## Properties

### `variant`

| Value | Looks like | Call sites | Where |
|-------|------------|-----------:|-------|
| `default` | `--primary` fill (ink black; white in dark), `--primary-foreground` text, no visible border | 0 | The fallback under every `tone` badge, never seen while the relay sends one of the four build statuses (below) |
| `secondary` | `--secondary` fill, `--secondary-foreground` text, no visible border | 2 | Token scope in the token table and in the Create token dialog |
| `destructive` | `--destructive` fill, `--destructive-foreground` text, no visible border | 0 | Defined, used nowhere. A red status uses `tone="rejected"` |
| `outline` | No fill, 1px `--border`, `--foreground` text | 2 | `No expiration` in the token table; the build filter chip on Runs |

### `tone`

Light-mode fill / text, then dark. No border (`border-transparent`). These are Tailwind palette colors, not
tokens: a tone does not follow a token change.

| Value | Light | Dark | Means | Shown for |
|-------|-------|------|-------|-----------|
| `backlog` | `zinc-100` / `zinc-600` | `zinc-800` / `zinc-400` | Not started, or nothing wrong with the app | Build status `Backlog`; run `Cancelled`; run and flow `Environment problem`; flow `Waiting` and `Not run`; build `Deletes in …` 6h or more away |
| `progress` | `blue-50` / `blue-700` | `blue-950` / `blue-300` | Under way | Build status `In Progress`; run and flow `Running` |
| `done` | `green-50` / `green-700` | `green-950` / `green-300` | Finished well | Build status `Done`; run and flow `Passed` |
| `rejected` | `red-50` / `red-700` | `red-950` / `red-300` | A problem with the app, or something about to happen | Build status `Rejected`; run and flow `Failed`; build `Deletes in …` under 6h, and `Deleting…` |
| `ios` | `sky-50` / `sky-700` | `sky-950` / `sky-300` | Platform | Build row, Settings → Apps |
| `android` | `emerald-50` / `emerald-700` | `emerald-950` / `emerald-300` | Platform | Build row, Settings → Apps |

Nine call sites pass `tone` (QA session header, build row ×3, Settings → Apps, Runs table, run detail ×3).
Call-site counts are a snapshot (2026-10-18).

**A failed run or flow is not always red.** One that failed only because of the device or the relay is `Environment
problem` in `backlog` gray (`failureBadge` in `lib/runs.ts`): red is kept for a regression in the app, the thing
a list of runs is scanned for. Draw both.

## How the two axes combine

`variant` defaults to `default`, so a `tone` badge also gets the `default` classes, and the `tone` classes come
after them and win (`tailwind-merge` keeps the last fill and the last text color). On screen a `tone` badge looks
only like its tone. In Figma the set is effectively one list of ten looks: four variants, six tones, no cross
product. That is how DESIGN.md counts it.

No call site switches between the axes. Settings → Apps used to show `both` as `secondary`; it now shows one `tone`
badge per platform row (#1086).

## Variations at the call site

| Where | Override | Why |
|-------|----------|-----|
| Most `tone` badges | `text-xs` | Already in the base class; changes nothing |
| Runs, build filter chip | `variant="outline"` + `gap-1 pr-1 font-normal`, and a 20px ghost ✕ button inside | A removable filter: build name, then a button that clears it. 26px high, regular weight |

**Platform labels are `iOS`, `Android` and `Both`** (`PLATFORM_LABEL` in `lib/build-format.ts`, #992). Before #992
the badge showed the API's lowercase value through CSS `capitalize`, which read "Ios".

The Runs filter chip is the only Badge holding a control. The ✕ is a real `Button` (`ghost`) with its own name
("Show runs of every build, not only …"): a 20px square, `rounded-md` (6px), `--accent` fill on hover, the shared
focus ring, and a 16px icon. The code asks for a 12px icon (`h-3 w-3`), but the Button's `[&_svg]:size-4` wins, so
draw 16px. The chip around it stays non-interactive.

## Usage

- Use `tone` for a status or a platform, `variant` for everything else. A new status gets one of the four status
  tones by what it means (table above), not a new color.
- Put the text on the badge, not just the color: every badge here says its state in words, so it reads the same
  without color.
- Do not make the badge itself clickable. A badge that needs an action holds a `Button`, like the Runs chip.
- `default` and `destructive` have no call site. Prefer `secondary` or `outline` for a neutral label, and
  `tone="rejected"` for a problem.

## Figma

Component set **Badge** in the `Design System` page — `variant` × 10 (the four variants and six tones in one
axis). The value names were not checked against this spec.
