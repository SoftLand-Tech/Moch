---
name: Moch
description: "Your agent runs on your phone. Your model is your choice."
colors:
  accent: "#f79236"
  on-accent: "#2e1a08"
  accent-line: "rgba(247, 146, 54, 0.38)"
  green-soft: "#4ade80"
  green-tint: "rgba(74, 222, 128, 0.12)"
  bg: "#0a0813"
  bg-soft: "#100e1a"
  card: "#151220"
  elevated: "#1a1727"
  text: "#ffffff"
  text-dim: "#b4b1c4"
  text-faint: "#86829b"
  cream: "#f6ece1"
  user-text: "#2b283b"
  on-cream-muted: "#575267"
  border: "rgba(248, 239, 229, 0.11)"
  border-soft: "rgba(248, 239, 229, 0.06)"
  border-strong: "rgba(248, 239, 229, 0.2)"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(3rem, 5.3vw, 4.5rem)"
    fontWeight: 800
    lineHeight: 1.01
    letterSpacing: "-0.035em"
  headline:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2rem, 5.8vw, 3.55rem)"
    fontWeight: 800
    lineHeight: 1.06
    letterSpacing: "-0.035em"
  title:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1.3rem, 3vw, 1.65rem)"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.95rem"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "normal"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.86em"
    letterSpacing: "-0.02em"
rounded:
  pill: "999px"
  circle: "50%"
  hero: "28px"
  card: "22px"
  container: "20px"
  control: "14px"
  phone: "32px"
  phone-screen: "25px"
  user-bubble: "14px 14px 5px 14px"
  assistant-bubble: "14px 14px 14px 5px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "12px 19px"
    size: "48px"
  button-primary-hover:
    backgroundColor: "#ffa34f"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "12px 19px"
    size: "48px"
  button-secondary:
    backgroundColor: "rgba(255, 255, 255, 0.035)"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "12px 19px"
    size: "48px"
  button-dark:
    backgroundColor: "transparent"
    textColor: "{colors.user-text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "12px 19px"
    size: "48px"
  button-small:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    size: "44px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.container}"
    padding: "24px"
  ingredient:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "18px"
    padding: "20px 18px"
  method-step:
    backgroundColor: "transparent"
    textColor: "{colors.text-dim}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "15px 6px"
    size: "88px"
---

# Design System: Moch

## Overview

**Creative North Star: "The Counter Recipe"**

Moch feels like a short, reassuring recipe for putting an agent on a phone: a dominant introduction, three ingredients, a numbered method, visible runtime proof and a choice of thinker. This is the shipped site's signature composition inside the existing Mocheme identity, not a separate visual world. The voice is friendly, plain and concrete; real Mochi artwork and honest interface illustrations carry the personality instead of decorative tech imagery.

The material system is near-black indigo, raised indigo card stock, Mochi cream and one sprout-orange action color. System typography keeps the site dependency-free and consumer-facing. On phones, major sections open into ruled editorial flows rather than a stack of boxes; on desktop, soft cards return and the recipe becomes a two-column countertop. Motion is brief and functional, never a persistent ambient effect.

The shipped system has no emojis, novelty display face, terminal/editor costume, third-party fonts, stock photography, analytics or tracking scripts. Monospace appears only where literal data or legacy commands benefit from it.

**Key Characteristics:**
- A recipe sequence with persistent numbered orientation and visible on-device proof.
- Mobile-open sections below 900px; soft, tonal desktop cards at 900px and above.
- Sprout orange for action and restrained emphasis; mint for on-device and success states.
- Cream reserved for the user's words, selected controls and high-contrast closing panels.
- Real Moch logo/Mochi assets, inline stroke icons and clearly labeled illustrative UI.

## Colors

The palette is hue-locked to Mochi's visor navy and cream, with sprout orange as the single brand accent and mint as a functional local/success signal.

### Primary
- **Sprout Orange** (`colors.accent`): primary download/setup actions, the phone send control, active mobile step marker and small emphasis lines.
- **Espresso Ink** (`colors.on-accent`): text and icons on sprout orange; dark ink is required rather than white.
- **Sprout Orange Line** (`colors.accent-line`): the default Hermes card and badge outline; a quieter accent cue than a filled action.

### Neutral
- **Mocheme Night** (`colors.bg`): page ground and inset runtime nodes.
- **Soft Night** (`colors.bg-soft`): the honest local-first band and isolated legacy setup area.
- **Raised Indigo** (`colors.card`): hero, proof, thinker, navigation disclosure and code-block-adjacent surfaces.
- **Inset Indigo** (`colors.elevated`): ingredient tiles, icon tiles, setup notes and the illustrative phone composer.
- **White** (`colors.text`): headings and primary copy.
- **Lavender Mist** (`colors.text-dim`): supporting paragraphs, secondary navigation and inactive controls.
- **Muted Lavender** (`colors.text-faint`): captions, build-adjacent metadata, diagram annotations and footer text.
- **Mochi Cream** (`colors.cream`): links, focus rings, selected pills, active number discs, user bubble and cream panels.
- **Visor Navy** (`colors.user-text`): ink on cream, including the user's chat bubble and closing panels.
- **Cream Panel Muted Ink** (`colors.on-cream-muted`): secondary copy inside cream panels.
- **Cream Hairline** (`colors.border`): default separators and quiet card edges.
- **Faint Hairline** (`colors.border-soft`): the sticky header's understated bottom rule.
- **Strong Hairline** (`colors.border-strong`): card perimeters, disclosure controls and emphasized dividers.

### Status
- **Local Mint** (`colors.green-soft`): beta presence dot, on-device badge, proof checks and active runtime-node icons.
- **Local Mint Wash** (`colors.green-tint`): the on-device pill background; active proof nodes use a separate low-opacity mint wash in component CSS.

**The Reserved Orange Rule.** Keep one strong orange action per region. Orange lines and washes may support emphasis, but orange is not scattered as decoration.

## Typography

**Display Font:** System UI stack (`system-ui`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `sans-serif`).
**Body Font:** The same system UI stack.
**Label/Mono Font:** System UI for labels; `ui-monospace`, `SFMono-Regular`, `Menlo`, `Consolas`, `monospace` for data and code.

**Character:** Large, heavy, tightly tracked headings create compression through scale and weight rather than a novelty face. Body copy is open and conversational, while monospace is a small literal-data voice.

### Hierarchy
- **Display** (800; desktop `clamp(3rem, 5.3vw, 4.5rem)`, 4.65rem at 1400px; mobile `clamp(1.9rem, 7.8vw, 2.6rem)`; 1.01 line-height; -0.035em tracking): the single hero heading on each page.
- **Headline** (800; desktop `clamp(2rem, 5.8vw, 3.55rem)`; mobile `clamp(1.65rem, 5.6vw, 2.2rem)`; 1.06 line-height): section headings. Proof, thinker and closing headings use smaller local clamps.
- **Title** (750; `clamp(1.3rem, 3vw, 1.65rem)`; 1.16rem below 900px; 1.2 line-height): card and subsection headings.
- **Body** (400; 16px/1.65 on desktop, 15px/1.65 below 900px): paragraphs and list copy. Reading measures are component-bound, usually 48–68ch.
- **Label** (750; 0.95rem/1.2): pill actions. Navigation uses 650 weight; badges and diagram labels use smaller 0.7–0.86rem sizes.
- **Data** (monospace; 0.86em; tabular numerals; -0.02em tracking): version/build values, step numbers and isolated legacy commands.

**The System Voice Rule.** System faces carry the consumer voice. Monospace is limited to build data, numbered markers and the isolated legacy command blocks; it must not turn the page into a terminal aesthetic.

## Layout

The shared shell is `width: min(calc(100% - 32px), 1220px)` with auto inline margins. At 480px the gutter becomes 48px, but the below-900px rule restores 32px. The sticky header is 68px tall, becomes 74px at 900px, respects the top safe-area inset and uses a soft translucent night background without backdrop blur. Anchor scrolling clears the header by 18px plus the safe-area inset.

The recipe flow is a single-column grid below 900px with 28px gaps and 12px top padding. Its section rhythm is 72px, increased to 88px at 680px; short landscape viewports reduce it to 54px. Recurring component gaps are 8–30px rather than a formal spacing-token scale. Text blocks commonly stop at 48–68ch.

Below 900px, major containers deliberately lose their card treatment: hero, proof, thinker, final CTA, download panel, setup finish, legacy panel, Hermes-only panel, release note and setup note become borderless, transparent, square-cornered open sections. Rules and spacing carry hierarchy. Ingredients become a single ruled list with a 34px icon column; thinker cards stack with horizontal rules; runtime nodes become ruled rows; the active method step gets a 3px orange inset rule instead of a filled card. The disclosure navigation, setup rail, phone shell, code blocks and small icon tiles retain their own containers.

At 900px the desktop shell returns. The hero becomes a copy/mascot grid, ingredients return as three equal tiles, method and proof share a 0.9fr/1.1fr row, and the method panel sticks below the header. Honest-local-first and FAQ sections become 0.78fr/1.22fr two-column layouts. The setup guide uses a 220px sticky rail plus content, widening to 240px at 1100px.

At 1200px the landing page becomes the full Counter Recipe countertop: a 350px-minimum left column and a wider right column. Hero spans both columns; ingredients stack as compact rows above the method on the left; runtime proof occupies the upper right and the thinker comparison sits beneath it. The method panel stops sticking, ingredients become vertical rows, the runtime diagram turns horizontal, and the model boundary becomes a 108px vertical dashed divider. At 1100px the proof detail additionally places its copy beside the 232px phone illustration.

Hero actions stack below 380px and become a no-wrap flex row from 380px, then wrap naturally at wider sizes. Setup rails use two columns on phones, three at 680px and one sticky column at 900px. The shipped pages reflow without document-level horizontal overflow at 320px.

**The Open-Section Rule.** Below 900px, remove card chrome from major content sections and let rules carry structure; do not turn the phone layout into a stack of boxed cards.

## Elevation & Depth

Depth is primarily tonal, not shadow-driven. Night, raised indigo and inset indigo establish the surface order; hairline borders do most of the remaining work. Shadows are reserved for genuinely floating or illustrative objects. There is no heavy glass treatment and no `backdrop-filter`.

### Shadow Vocabulary
- **Navigation disclosure** (`box-shadow: 0 24px 60px rgba(0, 0, 0, 0.48)`): the floating mobile menu only.
- **Primary action glow** (`box-shadow: 0 12px 30px -18px rgba(247, 146, 54, 0.9)`): a restrained lift under orange actions.
- **Hero lift** (`box-shadow: 0 28px 70px -46px rgba(0, 0, 0, 0.95)`): the desktop recipe card; removed with the rest of the mobile card chrome.
- **Phone lift** (`box-shadow: 0 24px 46px -28px rgba(0, 0, 0, 0.95)`): the illustrative handset inside runtime proof.
- **Mascot grounding**: drop shadows are applied to the real Mochi artwork, not to every card.

**The Flat-Surface Rule.** Cards are flat and tonal at rest. Reserve shadows for the floating menu, hero, primary action, phone illustration and mascot grounding.

## Shapes

The form language is soft, rounded and consumer-friendly: pill actions and badges, circular numbers and menu controls, 14px controls, 18–22px content cards and 28px hero/closing cards. The phone uses a 32px outer shell and 25px screen. Chat bubbles use asymmetric 14px corners with a 5px tail on the user's bottom-right and the assistant's bottom-left.

Borders are 1px cream-tinted hairlines. Dashed borders mark the model boundary, model chip, release note and legacy isolation; they mean "boundary" or "older path," not decoration. Icons use a 24px viewBox, render at 20px by default and use 1.8px round strokes.

**The Soft-Not-Glass Rule.** Use soft corners, hairline borders and tonal surfaces. Do not add hard neon glow, blur-heavy glass or sharp technical framing.

## Components

### Buttons
- **Character:** Friendly pill actions with a small lift, not square console controls.
- **Primary:** Sprout orange with espresso ink, label typography and the frontmatter padding/minimum size. The compact header variant is 44px tall with tighter horizontal padding.
- **Hover / Focus:** The primary action lightens to the `button-primary-hover` token and all buttons rise 1px over 160ms. Focus uses the global cream ring.
- **Secondary:** Translucent white surface, white text and a strong hairline; hover strengthens the border to cream and raises the white wash.
- **Dark:** Used on cream closing panels; transparent with visor-navy ink and a low-opacity navy border. Below 900px it switches to the dark-surface secondary treatment.
- **Icons:** Inline SVG, 20px, decorative `aria-hidden`; text remains live HTML.

### Chips and badges
- **Style:** Pill outlines for beta, thinker and model states; filled cream for selected step/model controls.
- **Beta mark:** A 7px mint presence dot precedes the label.
- **On-device label:** Mint text and mint wash with a shield icon; this is status, not an orange action.
- **Selection:** Selected model buttons use cream with visor-navy ink and `aria-pressed`.

### Cards / Containers
- **Corner Style:** Hero/closing cards use the hero radius; proof uses the card radius; thinker/download/setup cards use the container radius; ingredients use 18px.
- **Background:** Raised indigo for dark cards, inset indigo for ingredient tiles and Mochi cream for Hermes-only and closing panels.
- **Shadow Strategy:** Flat by default; see Elevation & Depth.
- **Border:** Strong hairline on hero/proof, default hairline on most cards, orange line on the default Hermes card.
- **Surface Detail:** The desktop hero layers a subtle orange radial wash in its upper-right with a 9px cream dot field; proof and thinker cards remain flat.
- **Internal Padding:** Frontmatter records the default card and ingredient values. Desktop hero/proof/final padding increases with breakpoint; below 900px the open-section rules replace card padding with editorial spacing.

### Inputs / Fields
No general text-field system ships. The only input is the dynamically revealed read-only copy fallback: full width, 44px minimum height, 12px radius, night background, strong hairline and inherited type. Clipboard success changes the button label to “Copied”; failure reveals a focused “Select & copy” field and announces the state.

### Navigation
- **Style:** Live-text Moch wordmark with the existing logo mark, compact 650-weight links and 44px minimum targets.
- **Desktop:** Horizontal navigation from 900px; hover/current state uses inset indigo. The nav download link is replaced by the compact header download button.
- **Mobile:** A 46px circular menu button controls an absolutely positioned disclosure panel with 20px corners, strong border and the navigation-disclosure shadow. Arrow Down opens and focuses the first link; Escape closes and returns focus; outside pointer dismissal and link-click closing are supported.
- **Progressive enhancement:** Without JavaScript the navigation remains visible below the brand and the menu button stays hidden.

### Disclosures
FAQ and troubleshooting entries use native `details`/`summary`, 64px and 58px minimum summary heights respectively, horizontal rules and a circular plus marker. The plus's vertical stroke rotates away over 160ms when open. The landing FAQ keeps only one item open at a time. Legacy instructions remain isolated in their own disclosure and dashed boundary.

### The Counter Recipe
The shipped landing sequence is: recipe hero → Linux/Thinker/Model ingredients → five-step method → runtime proof with hosted/local model preview → thinker comparison. The method is an ordered list of five full-width buttons; the active button updates `aria-pressed`, the proof heading/copy and the highlighted runtime node. Proof then continues into capability ledger, Hermes-only surfaces, honest local-first explanation, FAQ and closing download card.

The runtime diagram is Phone → Moch runtime → Hermes/OpenCode → model boundary → chosen model. It is vertical on phones and horizontal from 1200px. Mint marks on-device activity; the dashed model boundary and hosted/local labels make the network edge explicit. The adjacent phone is an HTML/CSS illustration with the real logo and Mochi artwork, captioned “Illustrative interface, not a screenshot.”

**The Active Step Rule.** Use a cream number disc for the active desktop step and a 3px orange inset rule on mobile. Use mint, not orange, to mark on-device runtime activity.

### Asset and illustration grammar
- Keep the existing `assets/logo.png`, `assets/favicon.png` and `assets/moch/*.svg` Mochi artwork. The wordmark stays live text.
- Use `mochi-greeting.svg` in the landing/setup heroes and illustrative phone, and `mochi-celebration.svg` in the final CTA.
- Use the shipped inline SVG sprite for interface icons; no icon font, CDN or third-party script.
- Keep product UI illustrations semantic HTML/CSS/SVG and label them as illustrative. Do not present the older `docs/screenshots/*.png` captures as the current OpenCode interface.
- Social sharing uses the shipped 1200×630 `assets/og-image.png`; keep its adjacent provenance record when regenerating it.
- No stock mascot replacement, local font files, third-party analytics or tracking assets.

### Motion
One orchestrated entrance runs after two animation frames: the hero enters over 620ms and ingredient tiles over 560ms with 80ms/150ms stagger, all using `cubic-bezier(0.16, 1, 0.3, 1)`. Content is visible before enhancement. State transitions use 160ms `ease-out`; runtime-node color transitions use 180ms. Smooth anchor scrolling is enabled by default. Step/model changes swap content and state attributes without a panel animation.

`prefers-reduced-motion: reduce` disables all animation and transitions, removes button/arrow transforms and makes scrolling immediate.

### Accessibility and progressive enhancement
- One `h1` per page; semantic header, nav, main, sections, articles, asides and footer; a skip link targets a focusable main landmark.
- Global focus is a 3px cream outline with 4px offset. Interactive targets are at least 44px; primary buttons are 48px and FAQ summaries 64px.
- The mobile menu exposes `aria-expanded` and `aria-controls`; method/model controls expose `aria-pressed`; proof copy is a polite live region.
- Method controls support Arrow keys, Home and End with wrapped focus movement. Model controls support Left/Right arrows.
- Copy controls use Clipboard API, selection-based fallback and a polite status region. FAQ behavior uses native disclosures enhanced by JavaScript.
- JavaScript-disabled visitors keep the content, static hosted proof and visible navigation; enhanced controls begin disabled and are enabled by `site.js`.
- Safe-area insets, clipped horizontal overflow, responsive reflow and reduced motion are part of the shipped implementation.

## Do's and Don'ts

### Do:
- **Do** keep the recipe order and make the on-device/model boundary visible wherever runtime behavior is explained.
- **Do** use the open-section layout below 900px and restore soft cards only at the desktop breakpoints.
- **Do** pair sprout orange with espresso ink and reserve mint for on-device/success meaning.
- **Do** keep actions and navigation targets at least 44px and preserve the 3px/4px cream focus ring.
- **Do** use the existing Moch assets and inline SVG icons, with provenance records for shipping rasters.
- **Do** label illustrative interface artwork and isolate legacy relay instructions from the current beta recipe.

### Don't:
- **Don't** turn the site into a terminal/code-editor aesthetic or use monospace as the main consumer voice.
- **Don't** stack boxed cards on phones or add glass blur, hard neon glow or decorative orange fields.
- **Don't** use white text on sprout orange; use the on-accent ink token.
- **Don't** imply that local-first means every request is offline or that stable v1.0.0 is the current local-first build.
- **Don't** replace Mochi with stock/generated mascot art or present legacy screenshots as current OpenCode UI.
- **Don't** add third-party fonts, analytics, tracking requests or icon-font dependencies.
