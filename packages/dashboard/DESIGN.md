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
| `--card` | `#ffffff` | `#1c1c1c` | Card, popover, dialog surface |
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
| `--sidebar-ring` | `#0070f3` | `#0070f3` | Sidebar focus ring (link blue) |

### Semantic

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--destructive` | `0 100% 47%` (~`#ee0000`) | `0 70% 62%` | Destructive actions, error states |
| `--destructive-foreground` | `#ffffff` | `#fafafa` | Text on destructive backgrounds |

> **Dark mode `--destructive`**: lightness is raised from `47%` to `62%`. Both the `/10` background opacity and the text color need L ≥ 60% to stay visible on dark surfaces.

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
| Monospace | JetBrains Mono (400) | `ui-monospace, SFMono-Regular, monospace` |

`font-feature-settings: 'ss01', 'ss02'` is applied globally on `body` to enable Inter's geometric alternate glyphs.

Mono is for the technical layer only — code blocks, `build_number`, `bundle_id`, UDIDs.

### Letter Spacing Tokens

| Tailwind class | Value | Apply to |
|----------------|-------|----------|
| `tracking-display-xl` | `-2.4px` | Hero-level headings |
| `tracking-display-lg` | `-1.28px` | Section headings |
| `tracking-display-md` | `-0.96px` | Card titles (Login, etc.) |
| `tracking-display-sm` | `-0.6px` | Small display headings |
| `tracking-body-sm` | `-0.28px` | Small body text |
| `tracking-tight` | Tailwind default | Sidebar team name, TechLabel |

### Hierarchy

| Element | Classes | Use |
|---------|---------|-----|
| Card title | `text-2xl font-semibold tracking-display-md` | Login "Welcome back", settings section titles |
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
| `z-tooltip` | 100 | Tooltips |
| `z-overlay` | 200 | Modal dim background |
| `z-modal` | 300 | Modal / dialog content |

## Elevation & Depth

Card hierarchy is expressed only through `shadow-card-{n}` tokens. All shadows follow a stacked small offsets + inset hairline structure.

| Level | Tailwind class | Shadow | Use |
|-------|----------------|--------|-----|
| 0 | (none) | none | Full-bleed regions, sidebar |
| 1 | `shadow-card-1` | inset 1px hairline | Flat cards that only need a boundary |
| 2 | `shadow-card-2` | soft drop + inset | **Default** — most cards |
| 3 | `shadow-card-3` | stacked drop + inset | Feature cards, emphasis panels |
| 4 | `shadow-card-4` | float stack + inset | Primary cards (Login, etc.) |
| modal | `shadow-modal` | 3-layer + inset | Dialogs, dropdown menus |

Apply via the `level` prop on the `Card` component:

```tsx
<Card level={2}>default card</Card>
<Card level={4}>Login card</Card>
```

## Shapes

### Border Radius Scale

| Tailwind class | Value | Use |
|----------------|-------|-----|
| `rounded-sm` | 4px | Badges, tight inset elements |
| `rounded-md` | 6px | Form inputs, nav buttons, dropdowns |
| `rounded-lg` | 8px | Cards (`--radius` default) |
| `rounded-pill` | 100px | Marketing-scale CTA buttons |
| `rounded-pill-sm` | 64px | Tab ghost pills |
| `rounded-full` | 9999px | Icon buttons, avatars |

## Components

### Buttons

6 variants × 6 sizes. Defined in `components/ui/button.tsx`.

**Variants:**

| Variant | Style | Use |
|---------|-------|-----|
| `default` | `bg-primary text-primary-foreground` | Primary CTA |
| `destructive` | `bg-destructive/10 text-destructive` (soft) | Delete, leave actions |
| `outline` | `border bg-background hover:bg-accent` | Secondary actions |
| `secondary` | `bg-secondary` | Tertiary actions |
| `ghost` | No background, hover only | Icon buttons, inline actions |
| `link` | `text-primary underline-offset-4` | Inline link buttons |

`destructive` uses a **soft variant** — translucent tint background with colored text, not a solid red fill.

**Sizes:**

| Size | Height | Use |
|------|--------|-----|
| `default` | h-10 (40px) | General buttons |
| `sm` | h-9 (36px) | Form submit, inline actions |
| `lg` | h-11 (44px) | Emphasized buttons, auth form submit (Login, Setup) |
| `icon` | h-10 w-10 | Square icon buttons |
| `pill` | h-12 (48px) + `rounded-pill` | Marketing-scale CTA |
| `nav` | h-7 (28px) + `text-xs` | Table inline, navigation |

### Cards

`components/ui/card.tsx` — elevation controlled via the `level` prop.

```tsx
<Card level={1}>  {/* flat */}
<Card level={2}>  {/* default, can be omitted */}
<Card level={4}>  {/* Login, primary entry screens */}
```

Composition: `CardHeader` (`p-6`) → `CardTitle` + `CardDescription` → `CardContent` (`p-6 pt-0`) → `CardFooter`.

### Inputs & Forms

`components/ui/input.tsx` — `h-10 rounded-md border border-input bg-background`. shadcn default.

File upload: use the **overlay pencil button on the current image** pattern instead of a "Choose file" button. Trigger the hidden `<input type="file">` via `fileInputRef.current.click()`. Update the preview immediately on selection with `URL.createObjectURL`.

### Navigation (Sidebar)

`components/app-sidebar.tsx` — built on shadcn `Sidebar`. Three groups:

1. **Main nav**: App Center, Mac Resources
2. **Settings** (`SidebarGroupLabel`): Default (all roles), Team · Tokens (Admin only)
3. **Reference** (`SidebarGroupLabel`): Docs external link

Header: team logo + team name, fetched from `/api/v1/settings`. Falls back to `logo.svg` + "tapflow".
Footer: `UserAvatar` + name/email dropdown (Settings, Log out).

### TechLabel

`components/ui/tech-label.tsx` — `font-mono text-xs tabular-nums tracking-tight`.

```tsx
<TechLabel>{build.buildNumber}</TechLabel>
```

### UserAvatar

`components/user-avatar.tsx` — renders the `avatarUrl` image if present, otherwise the first letter of the name with a hash-based color.

```tsx
<UserAvatar name={user.displayName} avatarUrl={user.avatarUrl} size={28} />
```

The placeholder color is determined by `avatarColors(name)`.

### Theme Toggle

`components/theme-toggle.tsx` — based on `next-themes` `useTheme`. Three states: light / dark / system.

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

### Destructive Button Style

Following shadcn v4: **soft variant** — translucent tint background with colored text, not a solid red fill.

```
bg-destructive/10  text-destructive  hover:bg-destructive/20
```

In dark mode, `--destructive` must be L ≥ 60% so both the `/10` background and the text color remain legible.

### Avatar Color System

Name-hash-based 6-slot palette.

```ts
// components/user-avatar.tsx
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

### Button Press Feedback

A `translateY(1px)` press effect is applied globally in `index.css` base layer — not in individual components.

```css
button:not([aria-haspopup]):not(:disabled),
[role="button"]:not([aria-haspopup]):not(:disabled) {
  transition-property: color, background-color, border-color, transform;
  transition-duration: 120ms;
}
button:active:not([aria-haspopup]):not(:disabled) {
  transform: translateY(1px);
}
```

Elements with `aria-haspopup` (Select, DropdownMenu triggers, etc.) are excluded to prevent visual glitches when opening overlays.

### Button Size Guidelines

| Context | size |
|---------|------|
| Form submit (Settings, etc.) | `sm` (h-9) |
| Inline actions within a list | `sm` |
| Navigation / table inline actions | `nav` (h-7) |
| Primary CTA (Login, marketing, etc.) | `pill` (h-12) |
