---
component: Breadcrumb
source: components/ui/breadcrumb.tsx
cva: none
own: item, state
---

# Breadcrumb

> Shared rules (state names, focus ring, disabled, tokens) live in [DESIGN.md](../../DESIGN.md).
> This file holds only what is specific to Breadcrumb.

`components/ui/breadcrumb.tsx` is shadcn's Breadcrumb: a list of links, separators and the current page. It has no
`cva`; `item` and `state` below are what renders, not props. It sits in the page header, after the sidebar toggle,
and **only the QA session uses it**. Other pages put a plain title there (see "Not Breadcrumb").

## Anatomy

```
☰ │  Coffee  ›  1.4.0 · build 42  ›  mac-mini-01  ›  iPhone 16 · 18.2
      link   sep   link              link            page
          10px between every item and separator
```

- **List** — one line of `text-sm` (14px on a 20px line), `--muted-foreground`, items and separators 10px apart
  (`sm:gap-2.5`; 6px below 640px, which the dashboard does not draw). A long trail wraps rather than truncating.
- **Link** — the text alone: no underline, no padding, no fill.
- **Page** — the last item, `font-medium` in `--foreground`. It is not a link you can follow: it takes no focus and
  does nothing on a click. shadcn's markup still exposes it to assistive technology as a disabled link
  (`role="link" aria-disabled="true"`) marked `aria-current="page"`.
- **Separator** — Lucide `ChevronRight`, 14px, `--muted-foreground`. Hidden from assistive technology.
- **Header** — the bar it sits in is 64px high with a 1px `--border` below and 16px on the sides. From the left: the
  sidebar toggle (28px, pulled 4px left, so 12px from the edge), a 16px vertical Separator, then the trail, all 8px
  apart and vertically centered.

`BreadcrumbEllipsis` (a 36px box with a "more" icon, for collapsing a long trail) is defined and unused. Do not draw
it.

## Properties

### `item`

| Value | Looks like | Call sites |
|-------|------------|-----------:|
| `link` | `--muted-foreground` text (`#888888` / `#a6a6a6`) | 1 — up to three per trail |
| `page` | `--foreground` text (`#171717` / `#fafafa`), medium weight | 1 — one per trail |
| `separator` | 14px chevron, `--muted-foreground` | 1 — between every two items |

### `state`

For `link` only; `page` and `separator` do not change.

| Value | Trigger | Looks like | Call sites |
|-------|---------|------------|-----------:|
| `default` | — | As `link` above | 1 |
| `hover` | `hover:` | `--foreground` text, with the global 120ms button transition (the base `button` rule outranks the link's `transition-colors`); pointer cursor | 1 |
| `focus` | Keyboard focus | The browser's default focus outline, not the shared ring: no focus style is set | 1 |

- Every link in the QA trail is a `<button>`, not an `<a>`, so it takes the global press motion (DESIGN.md): it
  moves down 1px while pressed. It also cannot be opened in a new tab.
- Link text on the header's `--background` (`#fafafa` / `#171717`) is 3.40:1 in light mode and 7.36:1 in dark. Light mode
  is under the 4.5:1 that 14px text needs; that is left to the designer's color pass, not a value to aim for.

## Variations at the call site

The QA session's trail grows as you go further in. Draw all three.

| Step | Trail | Beside it |
|------|-------|-----------|
| Choosing a Mac | App › **build** | The build's status Badge, when the build has one, 12px after the trail ([badge.md](./badge.md)) |
| Choosing a device on a Mac | App › build › **Mac** | — |
| A device is booting or running | App › build › Mac › **device · OS version** | — |

- **App** (the app's name) goes to the App Center with that app selected.
- **build** (`1.4.0 · build 42`) goes back to choosing a Mac; **Mac** goes back to choosing a device on it.
- **Going back from a running device shuts that device down at once**, with no confirmation, whichever of the
  three links is used. The App link does it by leaving the page.

## Not Breadcrumb

These pages put something else in the same header slot. They are hand-written and do not use the component.

| Page | What is there |
|------|---------------|
| Flow Runs, Mac Resources | The page's name, 14px medium, `--foreground` |
| A flow run | `Flow Runs / <build>`: a link in `--muted-foreground` (`--foreground` on hover), a `/` in `--muted-foreground`, then the build in medium. 6px apart. No chevron |
| Watching an AI session | `Watching <device>`, 14px medium |
| Every other page | Nothing: the slot is empty. So is the QA session's, until its build has loaded |

Flow run's trail looks like a breadcrumb but uses `/` and 6px gaps, not the chevron and 10px, and reads
`Flow Runs / Run` until the run has loaded. Its link is a real link (`<a>`): it can open in a new tab, does not move
when pressed, and changes color on hover at once, with no transition. Draw it as it ships.

## Usage

- Use the trail for a page you reach through steps inside one page, so each step can be gone back to. The last item
  is where you are and is not a link.
- Keyboard: Tab moves through the links in order, Enter or Space follows one. The current page is not a stop.
- The trail is a `nav` named "breadcrumb", and the current page is marked `aria-current="page"`.

## Figma

Two components on the `Navigation` page of tapflow-design-system:

- **BreadcrumbItem** (`25:694`) — `item` × `state`, 5 variants: `link` at `default`, `hover` and `focus`, `page`,
  `separator`, with a `Text` property. The focus look approximates the browser's default outline.
- **Breadcrumb** (`25:695`) — the trail, with one **Items** slot that accepts only BreadcrumbItem: links and
  separators alternating, ending with one page. The spec frame draws the three QA-session trails.
