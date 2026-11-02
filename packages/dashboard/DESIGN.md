# tapflow Dashboard — Design Reference

> Design system reference based on the dashboard implementation.
> Read this before writing new components or screens — follow the color tokens, typography, and elevation rules.

## Overview

The tapflow dashboard is the UI for a **self-hosted QA tool**. It takes a minimal, monochrome position inspired by Vercel's design system.

**Key characteristics:**

- **Monochrome-first**: No brand accent color. The UI is built entirely from ink-black (`#171717`) primary and gray scales.
- **Token-driven theming**: All colors are referenced through CSS variables only. No `dark:` hardcoding in components.
- **Elevation via shadow**: Card hierarchy is expressed with elevation levels (0–4). No single heavy drop-shadows.
- **Two typefaces**: Inter (sans-serif) + JetBrains Mono (mono). Technical identifiers like `build_number` and `bundle_id` must always use mono.
- **Negative tracking**: Heading letter-spacing is always negative. Positive tracking and all-caps headings are not allowed.

## Colors

All color values are defined as CSS variables in `src/index.css`. Tailwind references these variables.

### Surface

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--background` | `#fafafa` | `#171717` | Page background |
| `--card` / `--popover` | `#ffffff` | `#1c1c1c` | Card surface; `--popover` (same values) for Select and DropdownMenu content. Dialog and AlertDialog use `--background` |
| `--secondary` / `--muted` / `--accent` | `#f5f5f5` | `#262626` | Inset regions, hover backgrounds |

### Text

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--foreground` | `#171717` | `#fafafa` | Default body text |
| `--muted-foreground` | `#888888` | `#a6a6a6` | Secondary text, placeholders |
| `--sidebar-foreground` | `#4d4d4d` | `#cccccc` | Sidebar item text |

### Brand / Interactive

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--primary` | `#171717` | `#fafafa` | Primary CTA button, active link |
| `--primary-foreground` | `#ffffff` | `#171717` | Text on primary surfaces |
| `--ring` | `#171717` | `#fafafa` | Focus ring |
| `--sidebar-ring` | `#0076f5` | `#0076f5` | Sidebar focus ring (link blue) |

### Semantic

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--destructive` | `0 100% 47%` (~`#ee0000`) | `0 70% 62%` | Destructive actions, error states |
| `--destructive-foreground` | `#ffffff` | `#fafafa` | Text on destructive backgrounds |
| `--warning` | `48 100% 96%` (~`#fffbeb`) | `31 60% 14%` | Background of a notice that needs attention but blocks nothing |
| `--warning-foreground` | `31 85% 25%` | `48 65% 78%` | The notice's title. Its body stays `--foreground` |
| `--warning-border` | `48 97% 77%` (~`#fde68a`) | `31 50% 30%` | The notice's border |

> **Dark mode `--destructive`**: lightness is raised from `47%` to `62%`. Both the `/10` background opacity and the text color need L ≥ 60% to stay visible on dark surfaces.

> **`--warning` is a surface, not a solid colour.** `--destructive` fills a button, so it is the saturated
> red and its foreground is the text on it. `--warning` is only ever a notice box's pale fill, and
> `--warning-foreground` its title — never a dot, badge or line of text, where its near-white fill would vanish.
> Toasts keep sonner's own warning palette, and QASession's status dots and `Stale` label are still raw amber. It follows the avatar palette's rule: light
> mode pairs a pale fill with a dark title, dark mode a desaturated dark fill with a light one, and the
> title colours are slot 3's. The body is `--foreground` because it has to be read — `--muted-foreground`
> on the light fill is 3.5:1. Red stays for errors and destructive actions, so a notice that blocks
> nothing does not read as a failure next to a field's error. The border is `border-warning-border`:
> `border-warning` also exists, because the key nests, and paints the near-white fill.
>
> ```tsx
> <div className="rounded-lg border border-warning-border bg-warning px-4 py-3 text-sm">
>   <p className="font-medium text-warning-foreground">Title</p>
>   <p className="mt-1">Body</p>
> </div>
> ```

### Border / Input

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--border` / `--input` | `#ebebeb` | `#2e2e2e` | 1px dividers, input borders |

### Avatar Palette

Name-hash-based 6-slot colors. The `avatarColors(name)` function returns the CSS variables.

| Slot | Light bg / fg | Dark bg / fg |
|------|---------------|--------------|
| 1 (rose) | `hsl(353 90% 82%)` / `hsl(353 80% 28%)` | `hsl(353 40% 32%)` / `hsl(353 60% 78%)` |
| 2 (orange) | `hsl(25 100% 76%)` / `hsl(25 90% 25%)` | `hsl(25 42% 32%)` / `hsl(25 65% 78%)` |
| 3 (amber) | `hsl(48 100% 72%)` / `hsl(31 85% 25%)` | `hsl(48 42% 32%)` / `hsl(48 65% 78%)` |
| 4 (green) | `hsl(151 70% 70%)` / `hsl(151 80% 18%)` | `hsl(151 36% 28%)` / `hsl(151 50% 72%)` |
| 5 (blue) | `hsl(216 90% 78%)` / `hsl(216 85% 25%)` | `hsl(216 42% 32%)` / `hsl(216 60% 78%)` |
| 6 (purple) | `hsl(278 75% 84%)` / `hsl(278 75% 28%)` | `hsl(278 38% 32%)` / `hsl(278 55% 78%)` |

### Chart Colors

Used exclusively for the Area chart on the `MacResources` page. Five series colors.

| Token | Light | Dark |
|-------|-------|------|
| `--chart-1` | `216 85% 55%` (blue) | `216 80% 65%` |
| `--chart-2` | `262 65% 58%` (purple) | `262 60% 68%` |
| `--chart-3` | `30 80% 55%` (orange) | `30 75% 65%` |
| `--chart-4` | `151 65% 45%` (green) | `151 60% 55%` |
| `--chart-5` | `340 75% 55%` (pink) | `340 70% 65%` |

## Typography

### Font Family

Only two typefaces are used.

| Role | Family | Fallback |
|------|--------|----------|
| Default sans-serif | Inter (400/500/600) | `ui-sans-serif, system-ui, sans-serif` |
| Monospace | JetBrains Mono (variable; 400, and 500 where the parent is medium) | `ui-monospace, SFMono-Regular, monospace` |

`font-feature-settings: 'ss01', 'ss02'` is applied globally on `body` to enable Inter's geometric alternate glyphs.

Mono is for the technical layer only — code blocks, `build_number`, `bundle_id`, UDIDs.

### Letter Spacing Tokens

| Tailwind class | Value | Apply to |
|----------------|-------|----------|
| `tracking-display-xl` | `-2.4px` | Hero-level headings |
| `tracking-display-lg` | `-1.28px` | Section headings |
| `tracking-display-md` | `-0.96px` | Login and Setup card titles |
| `tracking-display-sm` | `-0.6px` | Small display headings |
| `tracking-body-sm` | `-0.28px` | Small body text |
| `tracking-tight` | Tailwind default | Sidebar team name, TechLabel |

### Hierarchy

| Element | Classes | Use |
|---------|---------|-----|
| Card title | `text-2xl font-semibold leading-none tracking-tight` | Every `CardTitle`. Login and Setup override it to `tracking-display-md` |
| Body emphasis | `text-sm font-medium` | Navigation labels, buttons |
| Secondary text | `text-sm text-muted-foreground` | Card descriptions, captions |
| Technical label | `font-mono text-xs tabular-nums tracking-tight` | `build_number`, `bundle_id` (`TechLabel` component) |

## Layout

### Spacing

Tailwind 4px base unit. `p-1`=4px, `p-2`=8px, `p-3`=12px, `p-4`=16px, `p-6`=24px.

Default card padding: `p-6` (24px). Dense contexts: `p-4` (16px). Sidebar areas: `px-3 py-3` (12px).

### Grid & Container

- Overall layout: `DashboardLayout` — a 2-column structure with `AppSidebar` on the left and a `main` content area on the right.
- Sidebar: shadcn `Sidebar` (`collapsible="icon"`) — expanded shows icon + label, collapsed shows icon only.
- Content width: no explicit max-width. The main area fills all space after the sidebar.

### Z-index Layer Tokens

| Tailwind class | Value | Use |
|----------------|-------|-----|
| `z-sidebar` | 10 | Sidebar |
| `z-tooltip` | 100 | Tooltips — **defined, used nowhere**; Tooltip uses `z-[50]` |
| `z-overlay` | 200 | Modal dim background — **defined, used nowhere**; Dialog and AlertDialog use `z-50` |
| `z-modal` | 300 | Modal / dialog content — **defined, used nowhere**; Dialog and AlertDialog use `z-50` |

## Elevation & Depth

Card hierarchy is expressed only through `shadow-card-{n}` tokens. All shadows follow a stacked small offsets + inset hairline structure.

| Level | Tailwind class | Shadow | Use |
|-------|----------------|--------|-----|
| 0 | (none) | none | Not used yet |
| 1 | `shadow-card-1` | inset 1px hairline | Not used yet |
| 2 | `shadow-card-2` | soft drop + inset | **Default** — settings sections, the release list |
| 3 | `shadow-card-3` | stacked drop + inset | Not used yet |
| 4 | `shadow-card-4` | float stack + inset | The single card of an entry screen (Login, Setup, Invite, Reset password) |
| modal | `shadow-modal` | 3-layer + inset | **Defined, used nowhere.** Overlays use Tailwind shadows instead: `shadow-lg` for Dialog, AlertDialog, Sheet and the DropdownMenu submenu; sonner's own `0 4px 12px` black at 10% for toasts; `shadow-md` for DropdownMenu and Select content and the MacResources chart tooltip |

Apply via the `level` prop on the `Card` component:

```tsx
<Card level={2}>default card</Card>
<Card level={4}>Login card</Card>
```

## Shapes

### Border Radius Scale

| Tailwind class | Value | Use |
|----------------|-------|-----|
| `rounded-sm` | 4px | Menu and select items, tab triggers, Kbd, dialog and sheet close buttons, tight inset elements |
| `rounded-md` | 6px | Form inputs, nav buttons, dropdowns |
| `rounded-lg` | 8px | Cards (`--radius` default) |
| `rounded-pill` | 100px | Marketing-scale CTA buttons |
| `rounded-pill-sm` | 64px | **Defined, used nowhere.** Tabs are a segmented control (`rounded-md` list, `rounded-sm` triggers) |
| `rounded-full` | 9999px | Icon buttons, avatars, badges |

## States

Every interactive component uses the same state names. A component spec lists only the states it has.

| State | Trigger in code | Look |
|-------|-----------------|------|
| `default` | — | The variant's resting tokens |
| `hover` | `hover:` | Defined per component — usually `--accent`, or the surface at reduced alpha |
| `focus` | `focus-visible:` (keyboard focus) | 2px `--ring` ring outside a 2px offset filled with `--background` (`ring-offset-background`) — drawn outside the box, never changes its size. On a surface other than `--background` (a card) the offset shows as a band |
| `disabled` | `disabled:` | 50% opacity, no pointer events |

- **Pressed is motion, not a state.** Every `<button>` and `[role="button"]` that is not `disabled` shifts down 1px
  while pressed (`translateY(1px)`, 120ms) and keeps its colors, so a pressed variant is drawn only where a
  component adds one. `SidebarMenuButton` adds `active:bg-sidebar-accent`, the same fill as its hover, so it needs no
  separate pressed drawing; as a link it does not shift. The rule is global in `src/index.css`:

  ```css
  button:not([aria-haspopup]):not(:disabled),
  [role="button"]:not([aria-haspopup]):not(:disabled) {
    transition-property: color, background-color, border-color, transform;
    transition-duration: 120ms;
  }
  button:active:not([aria-haspopup]):not(:disabled),
  [role="button"]:active:not([aria-haspopup]):not(:disabled) {
    transform: translateY(1px);
  }
  ```

  Elements with `aria-haspopup` — any trigger that opens an overlay, such as DropdownMenu, Dialog and
  AlertDialog triggers — are excluded, because the shift glitches when the overlay opens. A Select trigger has `role="combobox"` and no `aria-haspopup`, so it does shift. A `Button`
  rendered `asChild` as a link does not, since it is neither a `<button>` nor `role="button"`.
- **The ring is not the same everywhere.** `SidebarMenuButton` uses `--sidebar-ring` (link blue) with no offset,
  and `SelectTrigger` uses `focus:` rather than `focus-visible:`, so a mouse click shows its ring too. A text `Input`
  shows it on a click as well: browsers match `:focus-visible` on any focused text field (see [input.md](./design/components/input.md)).
  Read the component's base classes rather than assuming the shared ring.
- **A disabled field is shown by its control alone.** `Label` carries `peer-disabled:opacity-70`, but no call site
  puts a `peer` control before its label, so it never applies. See [label.md](./design/components/label.md).
- **Error does not change a control.** Inputs have no `aria-invalid` style; the error is the message below the
  field. Do not draw a red border.
- **No state that the code lacks.** `selected`, `loading` and similar are drawn only once they exist in code.
  `Card` and `Badge` are not interactive, so they have no `hover`.

## Components

Each component gets its own spec in [`design/components/`](./design/components/), written to one format:
anatomy, properties (the `cva` keys, verbatim), the tokens per state, and usage. **Values come from code
and keep their code names** — `default`, not `primary`. To rename one, change the code first.

`scripts/__tests__/designSpecMatchesCva.test.mjs` checks each spec's property values against the `cva`
it names, and that every spec below is linked and exists.

Axes match the Figma `Design System` page. A component with a spec lists only the axis names — the values and
their count live in the spec, which the check holds to code. A component without a spec yet is `pending`.

| Component | Source | Axes | Spec |
|-----------|--------|------|------|
| Button | `components/ui/button.tsx` | variant × size × state | [button.md](./design/components/button.md) |
| Label | `components/ui/label.tsx` | hint | [label.md](./design/components/label.md) |
| Card | `components/ui/card.tsx` | level | [card.md](./design/components/card.md) |
| Input | `components/ui/input.tsx` | state 3 × content 3 | [input.md](./design/components/input.md) |
| Select | `components/ui/select.tsx` | size 4 × state 3 × content 2 | [select.md](./design/components/select.md) |
| Dialog | `components/ui/dialog.tsx` | footer 2 | [dialog.md](./design/components/dialog.md) |
| Separator | `components/ui/separator.tsx` | orientation 2 | [separator.md](./design/components/separator.md) |
| Badge | `components/ui/badge.tsx` | variant 10 (variant 4 + tone 6) | [badge.md](./design/components/badge.md) |
| AlertDialog | `components/ui/alert-dialog.tsx` | — | [alert-dialog.md](./design/components/alert-dialog.md) |
| Tooltip | `components/ui/tooltip.tsx` | — | [tooltip.md](./design/components/tooltip.md) |
| TechLabel | `components/ui/tech-label.tsx` | tone 2 | [tech-label.md](./design/components/tech-label.md) |
| TabsTrigger | `components/ui/tabs.tsx` | state 4 | [tabs-trigger.md](./design/components/tabs-trigger.md) |
| SidebarMenuButton | `components/ui/sidebar.tsx` | variant × size × state | [sidebar-menu-button.md](./design/components/sidebar-menu-button.md) |
| DropdownMenuItem | `components/ui/dropdown-menu.tsx` | state | [dropdown-menu-item.md](./design/components/dropdown-menu-item.md) |
| Kbd | `components/ui/kbd.tsx` | context 2 | [kbd.md](./design/components/kbd.md) |
| SearchInput | `components/ui/search-input.tsx` | state 3 × content 2 | [search-input.md](./design/components/search-input.md) |
| TableRow | `components/ui/table.tsx` | type 2 × state 3 | [table-row.md](./design/components/table-row.md) |
| Textarea | `components/ui/textarea.tsx` | state 3 × content 2 | [textarea.md](./design/components/textarea.md) |
| Breadcrumb | `components/ui/breadcrumb.tsx` | item 3; state 3 (link only) | [breadcrumb.md](./design/components/breadcrumb.md) |
| Switch | `components/ui/switch.tsx` | checked 2 × state 3 | [switch.md](./design/components/switch.md) |
| Toast (sonner) | `components/ui/sonner.tsx` (`toast.*()`) | type 5 (4 + loading) | [toast.md](./design/components/toast.md) |
| Field | assembly pattern — `Label` + control + `FieldHint` / `FieldError` | control 5 × hint 3 × message 3 | [field.md](./design/components/field.md) |
| UserAvatar | `components/UserAvatar.tsx` | content 7 (image + 6 colors) | [user-avatar.md](./design/components/user-avatar.md) |

Not in this list on purpose: components with no call site, or reachable by no device today (`form.tsx`,
`avatar.tsx`, `CardFooter`, `Sheet`, `DropdownMenuRadioItem`, and others). Code kept for later is not
drawn — a designer would be drawing a screen that does not exist.

### Notes not yet moved into a spec

These move into the component's spec file when it is written.

#### Navigation (Sidebar)

`components/AppSidebar.tsx` — built on shadcn `Sidebar`. Three groups:

1. **Main nav**: App Center, Mac Resources
2. **Settings** (`SidebarGroupLabel`): Default (all roles), Team (Admin), Tokens (Admin, Developer, QA) — one rule, `lib/settingsAccess.ts`, for the sidebar and the route guard
3. **Reference** (`SidebarGroupLabel`): Docs external link

Header: team logo + team name, fetched from `/api/v1/settings`. Falls back to `logo.svg` + "tapflow".
Footer: `UserAvatar` + name/email dropdown (Settings, Log out).

#### TechLabel

`components/ui/tech-label.tsx` — `font-mono text-xs tabular-nums tracking-tight`.

```tsx
<TechLabel>{build.buildNumber}</TechLabel>
```

#### Theme Toggle

`components/ThemeToggle.tsx` — based on `next-themes` `useTheme`. A `ghost` / `icon` Button with two icons. It starts on `system` (`defaultTheme` in `src/main.tsx`), and a click only ever sets light or dark — from `system` the first click sets dark.

## Do's and Don'ts

### Do

- Reference colors only through CSS variable tokens (`bg-background`, `text-foreground`, `border-border`).
- Control card elevation with the `<Card level={n}>` prop.
- Wrap technical identifiers (`build_number`, `bundle_id`, UDID, version strings) in `<TechLabel>`.
- Use `avatarColors(name)` for all avatar placeholders.
- Choose a `tracking-display-*` token for heading letter-spacing (always negative).
- Use semantic z-index classes (`z-sidebar`, `z-modal`, etc.) instead of raw numbers.
- Use the overlay pencil button for image uploads — trigger the hidden `<input>` via ref, preview immediately with `URL.createObjectURL`.

### Don't

- No `dark:` class overrides in components (e.g. `dark:bg-gray-900`, `dark:bg-red-900`) — use CSS variable tokens only.
- Never use `bg-muted` directly for avatar placeholders — use `avatarColors(name)`.
- No single heavy drop-shadows — use `shadow-card-{n}` elevation tokens.
- Never use mono font for body paragraphs — mono is for technical identifiers only.
- Never combine `uppercase` with positive letter-spacing on headings.
- No raw numeric z-index (`z-50`, `z-100`, etc.) — use semantic token classes.
- No "Choose file" button for file uploads — use the overlay pencil button pattern.
- Never add button press feedback (`translateY`) directly to `aria-haspopup` elements — it causes visual glitches when opening overlays.

## Established Patterns

Patterns locked in during implementation. Follow these in all new components and screens.

### Dark Mode Theming

**Theme via CSS variables only — no `dark:` class overrides in components.**

```css
/* index.css */
:root  { --destructive: 0 100% 47%; }
.dark  { --destructive: 0 70% 62%; }  /* raised lightness so /10 opacity remains visible */
```

Components reference the variable only: `bg-destructive/10 text-destructive`.

### Avatar Color System

Name-hash-based 6-slot palette.

```ts
// lib/avatar.ts
export function avatarColors(name: string): { bg: string; fg: string }
```

Colors are defined as CSS variables (`--avatar-1-bg` … `--avatar-6-fg`) with separate light and dark values:
- **Light**: vibrant pastels (lightness ~70–84%)
- **Dark**: same hue, reduced saturation and lightness (~28–32%)

### Image Input Pattern (Avatar / Logo)

Replace "Choose file" buttons with an **overlay pencil button at the bottom-right of the current image**.

```tsx
<div className="relative w-14 h-14">
  {/* current image or initials placeholder */}
  <button
    type="button"
    onClick={() => fileInputRef.current?.click()}
    className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
  >
    <Pencil className="w-3 h-3" />
  </button>
  <input ref={fileInputRef} type="file" className="hidden" />
</div>
```

Update the preview immediately on file selection via `URL.createObjectURL`.
