## Overview

Vercel is a developer-platform brand — the page is a deployment dashboard's marketing surface, written for engineers who already know the syntax. It earns that posture with one of the cleanest stark systems on the web: near-white `{colors.canvas-soft}` body background, ink-near-black `{colors.ink}` text, a 200-step gray scale that gives every divider, border, and disabled state its own deliberate step. The only place the brand introduces colour at marketing scale is the multi-stop mesh gradient (`{colors.gradient-develop-start}` → `{colors.gradient-preview-end}` → `{colors.gradient-ship-start}` → cyan / magenta / amber) that floats in atmospheric backdrops, never miniaturised to a swatch. That gradient is the entire decoration system.

Type is the second decisive voice. The brand's own custom geometric sans (Geist) carries display, body, button — everything narrative — at weight 600 for display, 500 for buttons, 400 for body. A matching monospaced face (Geist Mono) carries technical labels: terminal mockups, code blocks, sometimes filename captions. Headlines are sentence-case with aggressive negative letter-spacing (`-2.4px` at 48 px hero) — the brand never letter-spaces positively, never goes uppercase outside of mono labels.

Surfaces use a four-step ladder: `{colors.canvas}` (pure white for cards), `{colors.canvas-soft}` 98% (the page body), `{colors.canvas-soft-2}` 95% (occasional inset region), `{colors.primary}` (the deep ink-near-black used as the polarity-flipped band when a section needs the dark mode treatment). Shadows are exceptionally subtle — every elevated card carries a stacked shadow built from `0px 1px 1px #00000005` + `0px 2px 2px #0000000a` + an inset border. Cards never float on heavy drop-shadow; they sit on the page held by hairline + soft glow.

**Key Characteristics:**

- A single black-ink primary CTA `{colors.primary}` carries every conversion target, paired with white-on-white `button-secondary` for the secondary action. The brand uses 100 px pill shape for marketing CTAs and a tight 6 px square shape for in-app nav buttons.
- A multi-stop mesh gradient (cyan-blue-magenta-amber) is the only decorative chrome — used at hero scale and inside feature-band atmospheric backdrops. It is the brand.
- Every section eyebrow and small label uses the monospace face `{typography.caption-mono}` or `{typography.code}`; everything else is in the geometric sans.
- Subtle stacked-shadow elevation — three offsets layered with 4-12 % black opacity — never a single heavy drop-shadow.
- A complete 100–1000 gray + blue + red + amber + green + teal + purple + pink colour scale exists as a system token set, but the marketing surface uses only the `100`, `1000`, and `700`-level tones; the rest stay in the design-system tokens for in-product surfaces.
- An "Active CPU" pricing rhythm: `pricing-card` lays out 3-up on the pricing page with `pricing-card-featured` (Pro tier) polarity-flipped to `{colors.primary}` against white-card siblings.

## Colors

### Brand & Accent

- **Ink** (`{colors.primary}` — `#171717`): The single primary CTA color. Black-near-pure ink that carries every Sign Up pill, every footer CTA, the dark-band polarity-flip. Used as text color throughout the page on light surfaces. (Resolved from `--ds-gray-1000`.)
- **Cyan** (`{colors.cyan}` — `#50e3c2`): A signature mint-cyan used in the brand gradient and inside Geist-system spotlight tokens. Visible inside the hero gradient stops.
- **Highlight Pink** (`{colors.highlight-pink}` — `#ff0080`): The brand's highlight magenta, used as the high-saturation stop in the preview-gradient pair.
- **Violet** (`{colors.violet}` — `#7928ca`): The deep purple used as the start of the preview-gradient and inside developer-console highlights.
- **Link Blue** (`{colors.link}` — `#0070f3`): The brand's primary link color and the legacy `--geist-success` semantic.

### Surface

- **Canvas** (`{colors.canvas}` — `#ffffff`): The pure-white card / dialog / modal surface.
- **Canvas Soft** (`{colors.canvas-soft}` — `#fafafa`): The default page background — 98 % white. Almost every section sits on this tone.
- **Canvas Soft 2** (`{colors.canvas-soft-2}` — `#f5f5f5`): A slightly deeper inset surface for "code editor inner background", template-card hover states, and dropdown menus.
- **Hairline** (`{colors.hairline}` — `#ebebeb`): 1 px dividers — table rows, card borders, input borders.
- **Hairline Strong** (`{colors.hairline-strong}` — `#a1a1a1`): The 500-level gray, used as the slightly-stronger divider on light bands and as the deemphasised text color.

### Text

- **Ink** (`{colors.ink}` — `#171717`): Every heading and body paragraph on light surfaces.
- **Body** (`{colors.body}` — `#4d4d4d`): Secondary text — sub-headings, body captions, nav-link inactive text, footer column body.
- **Mute** (`{colors.mute}` — `#888888`): Lowest-priority text — placeholder text, fine print, low-key labels.
- **On Primary** (`{colors.on-primary}` — `#ffffff`): All text on `{colors.primary}` surfaces.

### Semantic

- **Success / Link** (`{colors.success}` — `#0070f3`): The brand's legacy success indicator doubles as the primary link color. Visible underline-on-hover for inline body links.
- **Link Deep** (`{colors.link-deep}` — `#0761d1`): The pressed / visited tone for inline links.
- **Link Bg Soft** (`{colors.link-bg-soft}` — `#d3e5ff`): Soft pastel blue fill for "what's new" pill banners and informational badges.
- **Error** (`{colors.error}` — `#ee0000`): Validation red for destructive actions and form errors.
- **Error Soft** (`{colors.error-soft}` — `#f7d4d6`): Soft pastel red for destructive-state backgrounds.
- **Error Deep** (`{colors.error-deep}` — `#c50000`): Pressed / deep destructive state.
- **Warning** (`{colors.warning}` — `#f5a623`): Caution / pending status indicator.
- **Warning Soft** (`{colors.warning-soft}` — `#ffefcf`) / **Warning Deep** (`{colors.warning-deep}` — `#ab570a`): Background + pressed variants.

### Brand Gradient

The brand's signature decoration is a three-pair gradient stack:

- **Develop** (`{colors.gradient-develop-start}` `#007cf0` → `{colors.gradient-develop-end}` `#00dfd8`) — the blue-to-teal pair used to mark the "deploy" / "develop" rhythm.
- **Preview** (`{colors.gradient-preview-start}` `#7928ca` → `{colors.gradient-preview-end}` `#ff0080`) — the violet-to-pink pair used for "preview" surfaces.
- **Ship** (`{colors.gradient-ship-start}` `#ff4d4d` → `{colors.gradient-ship-end}` `#f9cb28`) — the coral-to-amber pair used for "ship" surfaces.

The three pairs collapse into a single multi-color mesh gradient when used as the hero atmospheric backdrop. Treat the gradient as one unified object — do not crop down to a single colour, do not reorder the stops, and do not miniaturise. Used at hero scale only.

## Typography

### Font Family

Two custom faces carry the entire system:

1. **A custom geometric sans** (extracted as `Geist`) for every display, body, button, link, and label. Weights 400 / 500 / 600 are the working set; the face never appears in 700 or heavier. Display sizes are tracked aggressively negative (`-2.4 px` at 48 px hero, `-1.28 px` at 32 px section); body stays at neutral or slightly-negative tracking.
2. **A custom monospaced face** (extracted as `Geist Mono`) for terminal mockups, code blocks, and small mono-caption labels — anything that wants to signal "technical." Weight 400 only at 12 – 13 px. Tracking neutral.

A condensed display sans (`Space Grotesk`) is loaded as a third face for occasional editorial moments but does not render as the primary face anywhere in the captured surfaces.

### Hierarchy

| Token                         | Size | Weight | Line Height | Letter Spacing | Use                                                                                    |
| ----------------------------- | ---- | ------ | ----------- | -------------- | -------------------------------------------------------------------------------------- |
| `{typography.display-xl}`     | 48px | 600    | 48px        | -2.4px         | Hero headline ("Build and deploy on the AI Cloud.").                                   |
| `{typography.display-lg}`     | 32px | 600    | 40px        | -1.28px        | Section headlines ("Your frontend, delivered.", "A compute model for all workloads."). |
| `{typography.display-md}`     | 24px | 600    | 32px        | -0.96px        | Card-cluster headlines, pricing-tier names.                                            |
| `{typography.display-sm}`     | 20px | 600    | 28px        | -0.6px         | Inline display micro-headings.                                                         |
| `{typography.body-lg}`        | 18px | 400    | 28px        | 0              | Lead paragraphs under section headlines.                                               |
| `{typography.body-md}`        | 16px | 400    | 24px        | 0              | Default body paragraph.                                                                |
| `{typography.body-md-strong}` | 16px | 500    | 24px        | 0              | Bolded inline body.                                                                    |
| `{typography.body-sm}`        | 14px | 400    | 20px        | -0.28px        | Secondary body, nav-link text, button-md labels.                                       |
| `{typography.body-sm-strong}` | 14px | 500    | 20px        | -0.28px        | Nav CTA labels, table-row emphasis.                                                    |
| `{typography.caption}`        | 12px | 400    | 16px        | 0              | Footer secondary lines, badge labels.                                                  |
| `{typography.caption-mono}`   | 12px | 400    | 16px        | 0              | Section eyebrows and label captions that want a technical voice.                       |
| `{typography.code}`           | 13px | 400    | 20px        | 0              | Inline code, terminal mockups, command snippets.                                       |
| `{typography.button-md}`      | 14px | 500    | 20px        | 0              | Small / nav-scale button labels.                                                       |
| `{typography.button-lg}`      | 16px | 500    | 24px        | 0              | Marketing-scale pill button labels.                                                    |

### Principles

- **Negative tracking is part of the voice.** Display sizes use aggressive `-2.4` to `-0.6` px tracking. Reverting to default tracking breaks the brand.
- **Sentence-case headlines, period-terminated.** Headlines like "Build and deploy on the AI Cloud." end with a deliberate period — that punctuation is part of the brand's voice.
- **Mono for the technical layer only.** Section eyebrows, code blocks, terminal mockups. Body paragraphs never set in mono.
- **Weight 600 is the display ceiling.** The geometric sans never appears at 700 / 800. The brand reads as a calmer system because of this.

### Note on Font Substitutes

The two primary faces are proprietary (custom-cut for the brand). Open-source substitutes:

- **Geometric sans** — _Inter_ (400 / 500 / 600) is the closest stylistic match; `font-feature-settings: "ss01", "ss02"` enables the geometric alternates. _Satoshi_ is a passable second choice.
- **Monospace** — _JetBrains Mono_ (400) at 12 – 13 px matches the technical voice. _IBM Plex Mono_ is the second-best option.

## Layout

### Spacing System

- **Base unit**: 4 px. The brand's `--geist-space` token is exactly 4 px and every captured value is a multiple of 4.
- **Tokens**: `{spacing.xxs}` 4 px · `{spacing.xs}` 8 px · `{spacing.sm}` 12 px · `{spacing.md}` 16 px · `{spacing.lg}` 24 px · `{spacing.xl}` 32 px · `{spacing.2xl}` 40 px · `{spacing.3xl}` 48 px · `{spacing.4xl}` 64 px · `{spacing.5xl}` 96 px · `{spacing.6xl}` 128 px · `{spacing.section}` 192 px.
- **Section padding**: marketing bands use `{spacing.4xl}` to `{spacing.5xl}` top/bottom. Hero bands stretch to `{spacing.section}` to give the mesh gradient room to breathe.
- **Card interior padding**: marketing cards sit at `{spacing.lg}` to `{spacing.xl}`; template-grid cards stay tighter at `{spacing.md}` because they sit in a denser grid.
- **Inline gap**: button rows, nav rows, and chip rows use `{spacing.sm}` to `{spacing.md}` between siblings. The brand's `--geist-gap` is exactly 24 px.

### Grid & Container

- **Max width**: ~1400 px (`--ds-page-width`); the legacy `--geist-page-width` is 1200 px and still appears on some marketing surfaces. Content centres with horizontal gutters of `{spacing.lg}` 24 px on desktop, `{spacing.md}` 16 px on mobile.
- **Column patterns**:
  - Three-feature row: 3-up at desktop, 1-up at mobile (rows like "Web Apps / Composable Commerce / Multi-tenant Platforms").
  - Tab pill row: 5-up centred row of `tab-ghost` pills.
  - Template-grid cluster: 5-up at desktop, scaling to 1-up at mobile.
  - Pricing tier grid: 3-up at desktop with the middle tier polarity-flipped.
  - Logo strip: ~5 logos wide, single row.

### Whitespace Philosophy

The mesh gradient does most of the heavy decorative lifting; whitespace separates the bands. Section spacing is generous — `{spacing.4xl}` to `{spacing.5xl}` between bands lets the gradient breathe. Inside a card, the headline/paragraph stack is tight (`{spacing.xs}` 8 px gap), then a wider gap before the CTA cluster. The page reads as engineered — large gaps + tight interior, never the other way around.

### Responsive Strategy

#### Breakpoints

| Name       | Width       | Key Changes                                                                                                       |
| ---------- | ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Mobile     | < 600px     | Hero stacks; nav collapses to hamburger; 3-up feature grids drop to 1-up; tab pill row enables horizontal scroll. |
| Tablet     | 600–959px   | 3-up grids drop to 2-up; nav still horizontal.                                                                    |
| Desktop    | 960–1199px  | Full 3-up grids; pricing 3-up.                                                                                    |
| Wide       | 1200–1399px | Container caps at 1400 px content width.                                                                          |
| Ultra-wide | ≥ 1400px    | Content stays centred at 1400 px; bands stretch edge-to-edge in colour but content holds the max-width.           |

#### Touch Targets

The `button-primary` pill renders at ~32 px tall in nav and ~48 px tall in marketing contexts. Marketing CTAs comfortably meet WCAG AAA at all breakpoints; nav buttons inflate touch area through `{spacing.xs}` padding on mobile to meet the 44 × 44 px floor.

#### Collapsing Strategy

- **Nav**: full link row + Ask AI / Log In / Sign Up pills at desktop. Collapses to logo + hamburger at mobile with the menu opening as a full-overlay.
- **Hero**: mesh gradient stays centred; headline + body stack vertically at all breakpoints (the brand doesn't use a split-hero pattern).
- **Three-feature row**: 3-up → 2-up → 1-up at the breakpoints above; cards keep their `{rounded.md}` 8 px shape across all viewports.
- **Pricing card grid**: 3-up at desktop, vertical stack at mobile with `pricing-card-featured` always sitting in the middle.
- **Template grid**: 5-up → 3-up → 2-up → 1-up. Each `template-card` keeps its 16:9 aspect on the image.

#### Image Behavior

- **Mesh gradient**: rendered as inline SVG or canvas-painted gradient; scales fluidly with the hero container; never crops, never tiles.
- **Customer logos**: rendered as monochrome SVGs in the logo strip; consistent 24 px height.
- **Code editor mockup**: dark `{colors.primary}` rectangle with mono text rendered inside; treated as an image at the layout level.
- **Template thumbnails**: 16:9 landscape inside `{rounded.md}` card chrome; lazy-loaded; consistent grayscale palette in the placeholder state.

## Elevation & Depth

| Level                    | Treatment                                                                                               | Use                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Level 0 — Flat           | No shadow, no border.                                                                                   | Full-bleed hero bands and the polarity-flipped dark sections.            |
| Level 1 — Inset Hairline | `0 0 0 1px #00000014` inset 1 px border.                                                                | Default card chrome — the brand's universal "you can see this card" cue. |
| Level 2 — Subtle Drop    | `0px 1px 1px #00000005, 0px 2px 2px #0000000a` plus inset hairline.                                     | Slightly elevated cards (template-grid, marketing-card).                 |
| Level 3 — Soft Stack     | `0px 2px 2px #0000000a, 0px 8px 8px -8px #0000000a` plus inset hairline.                                | The "medium" elevation — feature-grid cards.                             |
| Level 4 — Float Stack    | `0px 2px 2px #0000000a, 0px 8px 16px -4px #0000000a` plus inset hairline.                               | "Large" elevation — pricing cards, callout panels.                       |
| Level 5 — Modal          | `0px 1px 1px #00000005, 0px 8px 16px -4px #0000000a, 0px 24px 32px -8px #0000000f` plus inset hairline. | Modal / dialog surfaces and dropdown menus.                              |

The brand uses STACKED shadows — multiple small offsets layered to fake natural light — never a single 8-px-blur generic drop. Inset hairline rings are always added so the card edge stays crisp.

### Decorative Depth

- **Mesh gradient as atmospheric depth**: the hero's multi-stop gradient is the brand's only "atmospheric" effect — applied as a flat 2-D backdrop rather than a 3-D illustration.
- **Polarity-flipped dark band as section-depth**: switching the surface from `{colors.canvas-soft}` to `{colors.primary}` (the deep ink) is the brand's chief depth cue between bands.
- **Inset-shadow + drop-shadow combo**: the cards' combination of an inset 1 px ring and a multi-stop drop produces a "card sits on the page" effect without ever feeling material-heavy.

## Shapes

### Border Radius Scale

| Token               | Value  | Use                                                                                                  |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `{rounded.none}`    | 0px    | Full-bleed hero / footer bands.                                                                      |
| `{rounded.xs}`      | 4px    | Tightest inline pill — the `nav-cta-signup` 6-px-radius button (mapped to `xs/sm`).                  |
| `{rounded.sm}`      | 6px    | The brand's `--geist-radius` token — base UI radius for in-app buttons, form inputs, dropdown menus. |
| `{rounded.md}`      | 8px    | The brand's `--geist-marketing-radius` token — feature cards, template cards.                        |
| `{rounded.lg}`      | 12px   | Slightly larger card chrome (pricing-card variants).                                                 |
| `{rounded.xl}`      | 16px   | Largest card chrome — when a card hosts a hero image cap.                                            |
| `{rounded.pill-sm}` | 64px   | Tab-ghost pills inside the "AI Apps / Web Apps / Ecommerce / Marketing / Platforms" row.             |
| `{rounded.pill}`    | 100px  | The marketing CTA pill — `button-primary`, `button-secondary`, "Start Deploying" pill.               |
| `{rounded.full}`    | 9999px | Icon-button circular containers, nav-link ghost pills.                                               |

### Photography Geometry

- **Mesh gradient**: full-bleed 2-D atmospheric backdrop, never cropped to a frame; treated as the page's wallpaper.
- **Customer logos**: monochrome SVG, consistent 24 px height in a flex row.
- **Code editor mockup**: 16:10 dark rectangle, `{rounded.md}` corners.
- **Template thumbnails**: 16:9 landscape inside `{rounded.md}` chrome.
- **Showcase imagery**: 2:1 or 16:9 inside `{rounded.lg}` to `{rounded.xl}` chrome with a stacked shadow.

## Components

### Buttons

**`button-primary`** — the canonical 100-px-radius black pill, marketing scale.

- Background `{colors.primary}`, text `{colors.on-primary}`, label set in `{typography.button-lg}`, padding `0px {spacing.sm}` 12 px, shape `{rounded.pill}` 100 px. Renders ~48 px tall when paired with the marketing flex layout.

**`button-secondary`** — the white pill paired with the black primary inside marketing bands.

- Background `{colors.canvas}`, text `{colors.ink}`, same typography + padding as `button-primary`, shape `{rounded.pill}`.

**`button-primary-sm`** — the smaller-scale primary pill used inside nav and pricing-card CTAs.

- Background `{colors.primary}`, text `{colors.on-primary}`, label set in `{typography.button-md}` (14 px / 500), shape `{rounded.pill}`.

**`button-secondary-sm`** — the smaller-scale white pill paired with `button-primary-sm`.

- Background `{colors.canvas}`, text `{colors.ink}`, same typography + shape as `button-primary-sm`.

**`tab-ghost`** — the centred-row tab pill ("AI Apps / Web Apps / Ecommerce / Marketing / Platforms").

- Background `{colors.canvas}`, text `{colors.ink}`, label set in `{typography.body-sm}`, padding `0px {spacing.md}`, shape `{rounded.pill-sm}` 64 px.

**`icon-button-circular`** — the circular icon container (often a "?" or arrow inside).

- Background `{colors.canvas}`, dark icon, 1 px solid hairline border, shape `{rounded.full}`.

**Nav CTAs:**

**`nav-cta-signup`** — the small black "Sign Up" button in the nav row.

- Background `{colors.primary}`, text `{colors.on-primary}`, label `{typography.body-sm-strong}`, padding `0px {spacing.xs}`, height 28 px, shape `{rounded.sm}` 6 px (the brand's `--geist-radius`).

**`nav-cta-login`** — the white "Log In" button in the nav.

- Background `{colors.canvas}`, text `{colors.ink}`, same typography / height / shape as `nav-cta-signup`.

**`nav-cta-ask-ai`** — the small "Ask AI" button with a faint border.

- Background `{colors.canvas}`, text `{colors.ink}`, 1 px solid `{colors.hairline}` border (extracted as `0px solid rgb(235, 235, 235)`), same typography / height / shape.

### Cards & Containers

**`card-marketing`** — the canonical marketing feature card (3-up section cards).

- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.lg}` 24 px, shape `{rounded.md}` 8 px (the `--geist-marketing-radius`). Carries Level 3 soft-stack shadow.

**`card-marketing-large`** — the larger marketing card used for "compute model" / "AI Gateway" callouts.

- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.xl}`, shape `{rounded.lg}` 12 px. Carries Level 4 float-stack shadow.

**`card-soft`** — the soft-tinted card used inside cluster groups (lighter than canvas-soft).

- Background `{colors.canvas-soft}`, text `{colors.ink}`, padding `{spacing.lg}`, shape `{rounded.md}`.

**`template-card`** — the deploy-template card in the "Deploy your first app" grid.

- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.md}` 16 px, shape `{rounded.md}` 8 px. Hosts a 16:9 thumbnail at the top.

**`code-editor-mockup`** — the dark code-preview surface inside marketing bands.

- Background `{colors.primary}`, text `{colors.on-primary}`, body in `{typography.code}` (13 px / Geist Mono), padding `{spacing.lg}` 24 px, shape `{rounded.md}` 8 px.

**`pricing-card`** — the default pricing-tier card.

- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.xl}` 32 px, shape `{rounded.lg}` 12 px. Inside: tier name in `{typography.display-md}`, price in `{typography.display-xl}`, feature list in `{typography.body-md}` rows, CTA at the bottom.

**`pricing-card-featured`** — the polarity-flipped "Pro" tier card.

- Background `{colors.primary}`, text `{colors.on-primary}`, same shape + padding as `pricing-card`. CTA inverts to `button-secondary-sm` (white pill on black card).

### Inputs & Forms

**`form-input`** — the canonical text input.

- Background `{colors.canvas}`, text `{colors.ink}`, 1 px solid `{colors.hairline}` border, body in `{typography.body-sm}` (14 px), padding `0px {spacing.sm}`, height 40 px (the brand's `--geist-form-height`), shape `{rounded.sm}` 6 px.

**`form-input-sm`** — small-height variant (32 px tall) for tight forms.

- Same as `form-input` but height 32 px (the `--geist-form-small-height`).

**`form-input-lg`** — large-height variant (48 px tall) for hero CTAs.

- Same as `form-input` but height 48 px (the `--geist-form-large-height`); body in `{typography.body-md}` 16 px.

### Navigation

**`nav-bar`** — the sticky top nav.

- Background `{colors.canvas}`, text `{colors.ink}`, height 64 px (the brand's `--header-height`), padding `{spacing.sm} {spacing.lg}`. Layout: logo left, link row centre, "Ask AI / Log In / Sign Up" cluster right.

**`nav-link`** — the centred link row inside `nav-bar`.

- Text `{colors.body}`, set in `{typography.body-sm}`, padding `{spacing.xs} {spacing.sm}`, shape `{rounded.full}` (ghost pill — visible only on hover or active, but the radius is documented).

**`footer`** — the bottom 4-column nav.

- Background `{colors.canvas}`, text `{colors.body}`, padding `{spacing.4xl} {spacing.lg}`. Eyebrow column labels in `{typography.caption-mono}` (uppercase mono effect); link rows in `{typography.body-sm}`.

### Signature Components

**`hero-band`** — the white hero with the mesh gradient backdrop.

- Background `{colors.canvas}` (or `{colors.canvas-soft}` on some surfaces), text `{colors.ink}`, padding `{spacing.4xl} {spacing.lg}`. Inside: a small mono badge above the headline, the headline in `{typography.display-xl}` (sentence-case, period-terminated), a body lead in `{typography.body-lg}`, then a CTA row with `button-primary` + `button-secondary`. The mesh gradient sits behind, scaled to occupy roughly the top half of the band.

**`feature-mesh-band`** — the secondary section that hosts a mesh-gradient atmospheric backdrop with feature copy on top.

- Background `{colors.canvas}`, text `{colors.ink}`, padding `{spacing.5xl} {spacing.lg}`. Section headline in `{typography.display-lg}`; supporting body in `{typography.body-md}`.

**`showcase-band-light`** — a soft-canvas section ("Deploy your first app in seconds").

- Background `{colors.canvas-soft}`, text `{colors.ink}`, padding `{spacing.5xl} {spacing.lg}`.

**`showcase-band-dark`** — the polarity-flipped dark band ("A compute model for all workloads").

- Background `{colors.primary}`, text `{colors.on-primary}`, padding `{spacing.5xl} {spacing.lg}`. Section headline in `{typography.display-lg}` (white on black). Often contains a `code-editor-mockup` flush with the band.

**`logo-strip`** — the customer-logo wrapping row near the top of the page.

- Background `{colors.canvas}`, text `{colors.body}`, padding `{spacing.lg} {spacing.xl}`. Logos rendered as monochrome SVGs at consistent height.

**`badge-secondary`** — the small inline metadata pill ("New", "Beta", "Live").

- Background `{colors.canvas-soft}`, text `{colors.body}`, body in `{typography.caption}`, padding `0px {spacing.xs}`, shape `{rounded.full}`.

**`banner-marketing`** — the "Introducing X" announcement pill at the top of pages.

- Background `{colors.canvas-soft}`, text `{colors.body}`, body in `{typography.body-sm}`, padding `{spacing.xs} {spacing.sm}`, shape `{rounded.full}`.

**`link-inline`** — body-copy inline links.

- Text `{colors.link}` (`#0070f3`), body in `{typography.body-md}`, underlined.

### Examples (illustrative)

> Auto-derived kit-mirror demonstration surfaces (`scripts/derive-examples-block.mjs`). Each `ex-*` entry references brand-native primitives so downstream consumers (`/preview-design`, `/generate-kit`) re-skin the same 10 surfaces consistently. `TO_FILL` markers indicate missing primitives — resolve in the LLM judgment pass.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses feature-card chrome with brand canvas-soft surface.

- Properties: `backgroundColor`, `textColor`, `borderColor`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — polarity-flipped surface (dark fill + light text in light mode, light fill + dark text in dark mode).

- Properties: `backgroundColor`, `textColor`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for SaaS / B2B verticals (NOT a literal product gallery).

- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-cart-drawer`** — Subscription summary — re-purposed for SaaS / B2B (line items per add-on, not literal cart).

- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar nav row inside the App Shell example. Active state uses brand primary as the indicator.

- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses mono-caps eyebrow typography; body uses body-sm.

- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses feature-card chrome with text-input primitives inside.

- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — same chrome as feature-card with elevated shadow.

- Properties: `backgroundColor`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.

- Properties: `backgroundColor`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — feature-card shape + medium shadow.

- Properties: `backgroundColor`, `rounded`, `padding`, `typography`

## Tapflow Dashboard Design Decisions

아래는 tapflow 대시보드 구현 과정에서 확립한 패턴들이다. 새 컴포넌트·화면을 작성할 때 이 결정을 따른다.

### 다크 모드 테마 방식

**CSS 변수로만 처리, 컴포넌트에 `dark:` 클래스 금지.**

```css
/* index.css */
:root  { --destructive: 0 100% 47%; }
.dark  { --destructive: 0 70% 62%; }  /* 밝기를 높여 /10 opacity에서도 식별 가능 */
```

컴포넌트는 `bg-destructive/10 text-destructive` 처럼 변수만 참조한다. `dark:bg-red-900` 같은 하드코딩 오버라이드를 쓰면 CSS 변수 시스템이 깨진다.

### Destructive 버튼 스타일

shadcn v4 기준: **소프트 변형(Soft variant)** — 채운 빨강 대신 반투명 tint + 색 텍스트.

```
bg-destructive/10  text-destructive  hover:bg-destructive/20
```

다크 모드에서 `--destructive`를 충분히 밝게(L ≥ 60%) 설정해야 `/10` 배경과 텍스트 모두 식별된다.

### 아바타 색상 시스템

이름 해시 기반 6-slot 팔레트. **모든 아바타는 `avatarColors(name)` 함수를 통해 색을 받는다.**

```ts
// components/user-avatar.tsx
export function avatarColors(name: string): { bg: string; fg: string }
```

색상 값은 CSS 변수(`--avatar-1-bg` … `--avatar-6-fg`)로 정의되어 다크 모드를 처리한다.
- **Light**: 채도 높은 파스텔 (lightness ~70–84%)
- **Dark**: 같은 Hue, 채도·밝기 낮춤 (lightness ~28–32%)

새 아바타 플레이스홀더를 만들 때는 `bg-muted` 대신 이 함수를 사용한다.

### 이미지 입력 패턴 (아바타·로고)

"Choose file" 버튼 대신 **현재 이미지 위 우하단 오버레이 연필 버튼** 패턴을 쓴다.

```tsx
<div className="relative w-14 h-14">
  {/* 이미지 또는 이니셜 플레이스홀더 */}
  <button
    type="button"
    onClick={() => fileInputRef.current?.click()}
    className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-background border border-border shadow-sm flex items-center justify-center hover:bg-accent transition-colors"
  >
    <Pencil className="w-3 h-3" />
  </button>
  <input ref={fileInputRef} type="file" className="hidden" … />
</div>
```

파일 선택 즉시 미리보기(`URL.createObjectURL`)를 업데이트해 반응성을 제공한다.

### 버튼 Press 피드백

버튼 누름 시 `translateY(1px)` 피드백. 컴포넌트가 아닌 `index.css` base 레이어로 전역 적용.

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

`aria-haspopup` 속성이 있는 요소(Select·DropdownMenu 트리거 등)는 제외한다.

### 버튼 크기 가이드라인

| 컨텍스트 | size |
|---|---|
| 폼 submit (Settings 등) | `sm` (h-9) |
| 앱 목록 내 인라인 액션 | `sm` |
| 내비게이션·테이블 인라인 | `nav` (h-7) |
| 마케팅·히어로 CTA | `pill` (h-12) |

---

## Do's and Don'ts

### Do

- Reserve `{colors.primary}` (`#171717`) for primary CTAs across the page. Black ink IS the conversion target.
- Use `{rounded.pill}` 100 px for every marketing-scale CTA and `{rounded.sm}` 6 px for nav-scale buttons. The two pill scales coexist deliberately.
- Set every headline in `{typography.display-*}` weight 600, sentence-case, often period-terminated. Aggressive negative tracking is part of the voice.
- Use the brand mesh gradient as atmospheric decoration at hero scale only — never miniaturise it to an icon, never reduce to a single colour.
- Layer stacked shadows (multiple small offsets with inset hairline) rather than single heavy drops. The brand's elevation is calmer than Material.
- Cycle page surfaces in `{colors.canvas-soft}` → `{colors.canvas}` → `{colors.primary}` polarity-flipped bands; the dark band IS the depth cue.
- Set every code block and technical eyebrow in `{typography.code}` / `{typography.caption-mono}`. Mono is the voice of the platform.

### Don't

- Don't introduce a sixth accent colour. The brand operates with ink + gray + the four-pair gradient palette; new accents flatten the voice.
- Don't render headlines in all-caps. Sentence-case + negative tracking is non-negotiable.
- Don't drop a single heavy drop-shadow on cards. The brand's elevation is built from stacked small offsets + inset hairline rings.
- Don't render the brand gradient at icon scale or in a single-colour reduced form. The gradient lives at hero scale only.
- Don't promote the geometric sans to weight 700. The brand's display ceiling is 600.
- Don't pair the marketing 100-px pill CTA shape with the 6-px nav radius on the same screen — pick a scale and stay there.
- Don't set body paragraphs in the mono face. The mono is for code + technical labels only.
