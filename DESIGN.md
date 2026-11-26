---
name: Moch
description: "Your agent runs on your phone. Your model is your choice."
colors:
  accent: "#f79236"
  accent-hover: "#ffa34f"
  on-accent: "#2e1a08"
  accent-line: "rgba(247, 146, 54, 0.38)"
  green: "#4ade80"
  green-tint: "rgba(74, 222, 128, 0.12)"
  bg: "#0a0813"
  bg-soft: "#100e1a"
  card: "#151220"
  elevated: "#1a1727"
  text: "#ffffff"
  dim: "#b4b1c4"
  faint: "#86829b"
  cream: "#f6ece1"
  navy: "#2b283b"
  muted-ink: "#575267"
  line: "rgba(248, 239, 229, 0.11)"
  line-strong: "rgba(248, 239, 229, 0.2)"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(34px, 9vw, 48px)"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.045em"
  headline:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(28px, 7vw, 38px)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  title:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13.5px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  eyebrow:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.16em"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.92em"
    letterSpacing: "-0.02em"
rounded:
  pill: "999px"
  circle: "50%"
  card: "16px"
  panel: "18px"
  feature: "14px"
  control: "12px"
  tile: "9px"
  bubble-user: "12px 12px 4px 12px"
  bubble-assistant: "12px 12px 12px 4px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 17px"
    size: "44px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 17px"
    size: "44px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 17px"
    size: "44px"
  button-dark:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.cream}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 17px"
    size: "44px"
  product-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "0"
  feature-card:
    backgroundColor: "{colors.bg-soft}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.feature}"
    padding: "22px"
  thinker-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "24px"
  closing-panel:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.navy}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "30px 24px"
---

# Design System: Moch

## Overview

**Creative North Star: "Quiet Product Page"**

The site reads like a calm, current AI product page: a compact navigation bar, a two-column hero pairing one direct claim with an honest product mockup, a strip of four plain facts, then evenly spaced sections that each answer one question. Nothing is dressed up as a console, a dashboard or a launch campaign. The page earns trust by showing the product, stating limits and staying quiet.

The material system is near-black indigo ground, raised indigo cards, cream for emphasis and a single sprout-orange action color. Mint is functional only: on-device status, availability and checks. Type is the system UI stack, so the site stays dependency-free; monospace appears only for literal build data and commands.

**Key Characteristics:**
- One idea per section, separated by generous rhythm rather than decorative dividers.
- A real chat mockup as the hero's second column; no stock art, no abstract gradients.
- Bordered tonal cards on all sizes; no open-section/card-mode switch at a breakpoint.
- Orange for the primary action only; cream for the closing panel and inline links.
- Copy states what is local and what still uses the network, in the interface itself.

## Colors

### Primary
- **Sprout Orange** (`colors.accent`): the one filled action per region — header download, hero download, closing download.
- **Espresso Ink** (`colors.on-accent`): text and icons on orange; never white.
- **Orange Line** (`colors.accent-line`): the default thinker card edge, note rule and feature hover edge.

### Neutral
- **Mocheme Night** (`colors.bg`): page ground.
- **Soft Night** (`colors.bg-soft`): feature cards, the honest panel, step discs and code blocks.
- **Raised Indigo** (`colors.card`): hero product mockup, thinker cards, setup panels and the download panel.
- **Inset Indigo** (`colors.elevated`): icon tiles, the assistant bubble and flow-step discs.
- **White** (`colors.text`): headings and primary copy.
- **Lavender Mist** (`colors.dim`): body copy, navigation and secondary labels.
- **Muted Lavender** (`colors.faint`): eyebrows, captions, metadata and footer text.
- **Mochi Cream** (`colors.cream`): inline links, focus ring, step numbers, the user bubble and the closing panel.
- **Visor Navy** (`colors.navy`): ink on cream, including the user bubble and closing panel.
- **Cream Panel Muted Ink** (`colors.muted-ink`): supporting copy inside the cream closing panel.
- **Cream Hairline** (`colors.line`) / **Strong Hairline** (`colors.line-strong`): separators, card edges and control borders.

### Status
- **Local Mint** (`colors.green`): presence dots, check marks, thinker list bullets.
- **Local Mint Wash** (`colors.green-tint`): the "on this phone" pill background.

**The One Orange Rule.** Orange marks the action you want next. If a region already has a filled orange button, everything else there is cream, mint or a hairline.

## Typography

**Display and Body:** system UI stack (`system-ui`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `sans-serif`).
**Data:** `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`, `monospace`.

### Hierarchy
- **Display** (800; `clamp(34px, 9vw, 48px)`; 40–52px from 640px; 42–56px from 900px, capped at 680px wide; 1.05 line-height; -0.045em): the single hero heading on each page.
- **Headline** (800; `clamp(28px, 7vw, 38px)`; 30–40px from 640px; 1.1 line-height): section and closing headings. The honest panel and legacy panel use local 26–32px sizes.
- **Title** (700; 15px, 20px in thinker cards, 17–18px in setup options; 1.3 line-height): card headings.
- **Body** (400; 15px/1.65; 16px at 900px): hero lede, section intros and prose. Card copy sits at 12.5–13.5px. Measures stop at 48–68ch.
- **Label** (700; 13.5px): buttons and primary navigation. Section eyebrows are 10.5px uppercase at .16em; fact keys are 10px at .12em.
- **Data** (monospace; 0.92em): build and version values only.

**The System Voice Rule.** System faces carry the consumer voice. Monospace is reserved for build data and copyable commands; it must never turn the page into a terminal.

## Layout

The shell is `width: min(100% - 36px, 1120px)` with auto inline margins; gutters grow to 48px from 640px. The sticky header is 62px tall (70px from 640px) with a 1px hairline bottom edge and an opaque night background. Anchor scrolling clears the header by 18px.

The page sequence is: hero → four facts → features → thinkers → four-step start → honest local-first panel → FAQ → cream closing panel → footer. Sections use 56px vertical rhythm on phones, 72px from 640px and 96px from 900px; consecutive sections drop their top padding so the rhythm stays even.

Mobile is a single column. The hero stacks copy above the product mockup. Facts are a 2×2 ruled grid, features one per row, thinkers stacked, steps a numbered left-rail list. At 640px the hero stays stacked but facts become four columns, features two and steps two. At 900px the hero becomes `1.12fr / .88fr`, navigation moves inline, features become three columns, thinkers two and steps four across with a hairline running through the number row. The honest panel becomes two columns at 1000px (`0.9fr / 1.1fr`). The setup guide uses a sticky 210px rail from 900px, widening to 240px at 1100px.

The closing panel is a cream card: on phones the mascot is a 56px accent pinned top-right with the heading and copy padded clear of it, and the actions stack full width; from 640px it becomes a horizontal row with a 104px mascot on the right.

**The Even Rhythm Rule.** Sections are separated by spacing and hairlines, not by alternating background bands or decorative dividers.

## Elevation & Depth

Depth is tonal. Night, soft night, card and elevated surfaces establish order; 1px cream hairlines define edges. Shadows appear in exactly two places.

### Shadow Vocabulary
- **Product mockup** (`box-shadow: 0 30px 70px -44px rgba(0, 0, 0, .95)`): lifts the hero chat card off the ground.
- **Presence dot** (`box-shadow: 0 0 10px rgba(74, 222, 128, .55)`): the mint glow on the beta dot and live status dots.

**The Flat-Surface Rule.** Cards are flat at rest. No glass, no blur, no neon glow, no shadow on hover — hover changes borders, not elevation.

## Shapes

Pills for actions, badges, tags and chips. Circles for step numbers, the menu control and the send button. Cards use 16px corners, panels 18px, feature cards 14px, icon tiles 9px and controls 12px. Chat bubbles use asymmetric 12px corners with a 4px tail toward the sender.

Borders are 1px. Dashed borders mean "legacy or boundary" and appear only on the legacy setup panel. Icons are inline SVG on a 24px viewBox, rendered at 14–19px with 1.8–1.9px round strokes.

**The Soft-Not-Glass Rule.** Rounded, hairline-bordered, tonal. No hard technical framing, no gradient mesh, no glow.

## Components

### Buttons
- **Primary:** orange pill, espresso ink, 44px minimum height, 13.5px/700 label; hover lightens to `accent-hover` and lifts 1px over 160ms.
- **Ghost:** transparent with a strong hairline; hover turns the border cream.
- **Dark:** navy pill with cream ink, used inside the cream closing panel.
- **Hero pair:** a two-column grid at every width so both actions stay on one line down to 320px. The primary label is the short "Download beta"; the full "Download the current beta" wording is kept on the closing panel and setup guide.
- **Icons:** 14–15px inline SVG, decorative and `aria-hidden`.

### Hero product mockup
A bordered card with a 46px title bar (logo, "Mochi", mint "On this phone" status), a short chat exchange, tool chips, and a composer with a model chip and orange send control. The user bubble is cream with navy ink; the assistant bubble is elevated indigo with a hairline. It is illustrative UI built in HTML/CSS, not a screenshot.

### Facts strip
Four ruled cells with a 10px uppercase key and a 13.5px value: platform, runtime, model choice, account requirement. Two columns on phones, four from 640px.

### Feature grid
Tonal soft-night cards with a 36px inset icon tile, a 15px title, 13px body and an optional uppercase "Hermes only" note. Hover only shifts the border to orange.

### Thinker cards
Two raised-indigo cards comparing Moch (Hermes) and OpenCode. The default card carries the orange edge and an orange "Default" tag; the other uses a neutral tag. Lists use mint bullets; a closing fine-print line explains that existing chats keep their thinker.

### Steps
A four-step "start" sequence. On phones each step is a 40px cream-numbered disc in a left rail; from 640px it becomes a two-column grid; from 900px four columns with a hairline through the number row and text beneath.

### Honest local-first panel
A soft-night panel with a 28–32px heading, the required local-first caveat, a build/release note, and two rule-separated columns: "Stays on the phone" and "Can use the internet". Dashes in orange mark list items. It is the one place that argues rather than describes, and it does so plainly.

### FAQ and troubleshooting
Native `details`/`summary` with a hairline under each row, 17px vertical padding, and a text `+`/`−` marker at the right. The landing FAQ keeps one item open at a time; setup troubleshooting uses the same pattern.

### Closing panel
A cream card with navy heading, muted ink copy, a dark primary download button and an underlined setup link. On phones the mascot is a small top-right accent; from 640px it sits at the right edge at 104px.

### Navigation
- **Desktop (900px+):** live-text wordmark with the logo mark, 13.5px links, a ghost "Setup guide" and the orange download button.
- **Mobile:** a 44px circular menu button toggles an absolutely positioned panel under the header. `aria-expanded` and `aria-controls` are wired; Escape closes and returns focus; outside clicks and link clicks close it. Without JavaScript the nav stays visible.

### Setup page
A hero with the download card, a sticky section rail (chips on phones), numbered step sections with a 38px disc, tonal panels for instructions, copy buttons for commands, an option/provider grid, a cream finish panel, and a dashed legacy panel that keeps stable v1.0.0 clearly separated.

### Asset and illustration grammar
- Keep `assets/logo.png`, `assets/favicon.png` and `assets/moch/*.svg`. The wordmark stays live text.
- Logo mark renders at 32px in the header and 28px in the footer; the hero mockup uses 21–25px.
- Use `mochi-greeting.svg` in the product mockup and `mochi-celebration.svg` in the closing panel.
- Product UI illustrations are semantic HTML/CSS, labelled illustrative. Do not present legacy `docs/screenshots/*.png` as current UI.
- Social sharing uses the shipped 1200×630 `assets/og-image.png` with its provenance record.
- No stock mascot, third-party fonts, analytics or tracking.

### Motion
State changes use 160ms ease-out: button lift, border color, hover. Anchor scrolling is smooth and becomes immediate under `prefers-reduced-motion: reduce`. `site.js` adds a `motion-ready` class after two animation frames so content is never hidden before enhancement. No scroll-triggered or ambient animation.

### Accessibility and progressive enhancement
- One `h1` per page; semantic header, nav, main, sections and footer; skip link to a focusable main.
- Focus is a 2px cream outline with 3px offset.
- Targets are at least 44px; the menu button is 44px.
- `site.js` owns navigation, copy buttons, version sync, FAQ grouping, the current year and enhancement hooks; no inline scripts.
- Reduced motion, safe-area insets, 320px reflow and 200% zoom are part of the shipped implementation.

## Do's and Don'ts

### Do:
- **Do** lead with the approved headline and keep the required local-first caveat visible near the first privacy claim.
- **Do** show the product as a labelled chat mockup rather than a screenshot or abstract illustration.
- **Do** keep one orange action per region and reserve mint for on-device/success meaning.
- **Do** keep both hero actions on one line at 320px.
- **Do** use the existing Moch assets and inline SVG icons.
- **Do** keep the stable v1.0.0 legacy path isolated and clearly labelled.

### Don't:
- **Don't** reintroduce the Counter Recipe composition, numbered method controls or runtime diagrams.
- **Don't** alternate full-bleed background bands between sections.
- **Don't** use white text on orange, glass blur, neon glow or gradient mesh.
- **Don't** imply local-first means every request is offline, or that v1.0.0 is the current build.
- **Don't** present OpenCode as the default thinker or the free models as on-device.
- **Don't** add third-party fonts, analytics, tracking or icon fonts.
