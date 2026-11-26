---
version: 1
slug: "docs-index-html"
primary_target: "docs/index.html"
related_targets: ["docs/setup.html"]
---

# Moch landing + setup surface brief

## Scope and mode

- Primary target: `docs/index.html`
- Related target: `docs/setup.html`
- Shared files: `docs/moch.css`, `docs/site.js`, `docs/assets/**`, approved current screenshots/illustrations only
- Visitor mode: **Persuade**
- Build path: **code-first** (image comp generation unavailable; user approved the wireframe choice)

## Audience, job and action

- Primary audience: general local-AI users who want an agent on their phone without running a remote server or creating a Moch account.
- Secondary audience: developers already using OpenCode.
- Visitor job: understand what Moch is, why it is local-first, how Hermes and OpenCode differ, and what network use remains.
- Primary action: **Download the current beta** (`/Moch.apk`).
- Secondary action: **See how it works** (`setup.html`).
- Proof: the on-device runtime path, the real first-run flow, current beta version, stable-vs-beta honesty, and concrete current UI illustrations.

## Chosen composition: The Counter Recipe

The page behaves like a short, reassuring recipe for putting an agent on a phone. This is a composition choice inside the existing friendly Mocheme world, not a new visual identity.

### Direction contract for the HTML comment

- **THESIS:** Getting an agent on your phone feels like following a short, reassuring recipe; refuse the stock hero-plus-feature-card grid and the retired relay/QR story.
- **OWN-WORLD:** Mocheme near-black indigo, antenna orange reserved for action, cream for the user's own words, soft rounded card stock, real Mochi artwork, plain consumer typography, no emojis and no terminal/editor aesthetic.
- **STORY:** The visitor learns that the agent runs on the phone, chooses Hermes or OpenCode, understands hosted-vs-local models, downloads the current beta, and follows the real four-step onboarding.
- **FIRST VIEWPORT:** Minimal sticky Moch nav; one large recipe-style hero card with the exact approved headline, one-sentence explanation, Mochi at the upper-right, primary beta download and secondary setup CTA; directly below, the Linux/Thinker/Model ingredient strip.
- **FORM:** The Counter Recipe, selected from the dealt surface structures; code-first wireframe `.impeccable/mocks/decision/surface-options.json`, seed key `998348e1`.
- **FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## Composition commitments

1. Sticky minimal header: Moch mark/wordmark, compact anchor navigation, accessible mobile menu, primary download action on wider screens.
2. Recipe hero: one dominant soft card, exact headline, concise support copy, two actions, real Mochi artwork, current beta label.
3. Ingredient strip: three equal rounded tiles — **Linux**, **Thinker**, **Model** — each with a one-line explanation.
4. Method: five numbered steps — Download beta, choose environment, choose thinker, connect model, chat — with a persistent step rail on desktop and vertical progression on mobile.
5. Local-runtime proof: Phone → Moch runtime → Hermes or OpenCode → chosen model. The model boundary is visibly marked as on-device or hosted.
6. Thinker cards: Moch (Hermes) default/full surface; OpenCode optional/coding-agent surface; existing chats keep their thinker.
7. Capability section: Chat, Projects, Terminal, Browser; Hermes-only Fleet/Crew/Automations clearly separated.
8. Honest local-first section: required network caveat, no Moch account/relay/remote gateway in the standard CI path, stable v1.0.0 legacy warning.
9. FAQ and close: Android/iOS/Expo Go, Linux requirement, local/hosted models, OpenCode install, stable-vs-beta, legacy relay users; final download/setup CTA.
10. Desktop expansion: two-column countertop — method/ingredients on the left, phone/runtime proof and thinker cards on the right. Do not simply center the mobile page.

## Component and type grammar

- Ground: `#0A0813`; raised card: `#151220`; elevated inset: `#1A1727`.
- Primary accent: `#F79236` with `#2E1A08` ink; cream: `#F6ECE1`; secondary text: `#B4B1C4`.
- Soft rounded cards (18–24px), pill actions, gentle borders, no hard neon glow or heavy glass.
- System font stack; large compressed-feeling headline through size/weight rather than a novelty face; clear 16–18px body; mono only for version/build data.
- One strong orange action per region; orange is not scattered as decoration.
- Motion: one orchestrated reveal for the recipe card and ingredient tiles; step activation may update the proof panel. Respect `prefers-reduced-motion`.

## Visible ingredient inventory and implementation medium

| Ingredient | Implementation medium | Notes |
|---|---|---|
| Moch logo + wordmark | Existing `assets/logo.png` + live text | Do not upscale beyond native usefulness; wordmark stays text. |
| Mochi hero artwork | Existing `assets/moch/mochi-greeting.svg` or `logo.png` | Real shipped asset, not CSS shapes. |
| Recipe hero card | Semantic HTML/CSS | Exact headline and actions; no rasterized text. |
| Ingredient tiles | Semantic HTML/CSS | Three tiles, equal weight, one-line explanations. |
| Numbered method | Semantic HTML/CSS + `site.js` | Step buttons update proof panel; keyboard accessible. |
| Runtime diagram | Inline SVG + HTML labels | Countable geometry; model boundary explicit. |
| Phone/product UI | Semantic HTML/CSS/SVG illustration | Built from current app tokens; label as illustrative if not a real capture. |
| Thinker cards | Semantic HTML/CSS | Feature differences and default/optional labels. |
| Icons | Inline SVG | Consistent 1.6–2px stroke, no icon font/CDN. |
| OG/social image | Authored SVG converted to PNG with ImageMagick | 1200×630; exact headline; real brand; provenance sidecar. |
| FAQ | Native `<details>` or accessible button pattern | No dependency; keyboard operable. |
| Copy buttons | `site.js` + Clipboard API fallback | Clear success/failure state. |

## Setup page contract

`setup.html` uses the same recipe grammar and shared shell. It documents the actual on-phone flow: download beta → environment → thinker → providers → about you. Legacy v1.0.0/moch-link/relay instructions live in a clearly separated final section. No QR pairing in the primary flow.

## Accessibility and responsive requirements

- Base styles target 320–390px; enhance with `min-width`.
- 44px minimum touch targets; safe-area insets; no horizontal overflow.
- One `h1` per page; skip link; labelled nav; `aria-expanded` menu; visible focus.
- Sticky anchors clear the header; landscape reflow; 200% zoom.
- No third-party fonts, analytics, scripts or tracking requests.
- Reduced motion disables non-essential animation.

## Finish and unresolved items

- Run the mechanical detector once after the build.
- Capture desktop and mobile screenshots for one review batch; fix material findings once; confirm once.
- Write `DESIGN.md` from the shipped system after the last fix.
- Custom GitHub social-preview upload remains a manual dashboard step unless a supported API is discovered.
- Automated VPS deployment depends on repository SSH secrets; manual deployment remains available.
