# Product

<!-- impeccable:product-schema 1 -->

Canonical product truth: [`../../PRODUCT.md`](../../PRODUCT.md). This copy is kept in sync with it.

## Platform

web

## Stack

Static HTML, CSS and vanilla JavaScript in `docs/`; no framework or build step. The production site is served from `/var/www/moch` on the Moch VPS. Android CI artifacts are published as GitHub pre-releases and copied to `/Moch.apk` on the site.

## Users

The primary visitor is a general local-AI user who wants a useful AI agent on their phone without operating a remote server or creating a Moch account. They may not know Hermes or OpenCode yet, so the site must explain the choice in plain language. Developers already using OpenCode are a secondary audience and need a clear technical path without making the first viewport feel like a terminal.

## Product Purpose

Moch is an open-source Android AI workspace with an on-device agent control plane. Hermes runs embedded by default; OpenCode can run inside the optional Moch Linux Ubuntu guest. The product brings chat, projects, tools, a terminal and browser control together on the phone.

Website success means a first-time visitor understands that the agent runs on their phone, understands that they choose the thinker and model provider, trusts the privacy/network explanation, and downloads the current CI beta or follows the real on-device setup flow.

## Positioning

**Moch — your agent runs on your phone. Your model is your choice.**

The standard current CI path requires no Moch account, Moch relay or remote gateway. Hermes and OpenCode use on-device control planes; sessions and workspace files live on the phone. Users may connect hosted model providers or a local model endpoint.

Moch integrates OpenCode as a selectable thinker. It is not the official OpenCode app, and OpenCode is not currently the default thinker.

## Operating Context

- Current development build: **1.0.53-beta.3, versionCode 58**.
- Stable GitHub release: **v1.0.0**, a legacy linked/relay-only build. It does not contain the embedded runtime or OpenCode and must never be presented as the current local-first experience.
- First-run flow: **Environment → Thinker → Providers → About you**.
- Ubuntu 24.04 is the default guest selection; users can skip Linux, but OpenCode requires the guest.
- OpenCode is downloaded from `opencode.ai` into Moch Linux on first selection, then runs on-device in server mode or a reduced one-shot fallback.
- Hermes remains the default thinker and the broader feature surface. OpenCode keeps Chat, Projects/OpenCode sessions, Terminal, Browser and Settings; Hermes-specific Fleet, Crew, Automations, Skills, Connectors and Inbox are hidden in OpenCode mode.
- Expo Go is not equivalent to the release APK because the native embedded-runtime bridge is unavailable there.
- The repository still contains legacy `moch-link` and relay code for the stable v1.0.0 era. The new site must not lead with QR pairing or remote setup.

## Capabilities and Constraints

### Verified capabilities

- Embedded Hermes runtime and local loopback gateway.
- Optional OpenCode thinker inside the on-device Ubuntu/proot guest.
- Streaming chat, thinking/tool activity, approvals, projects and session history, subject to thinker differences.
- Terminal tabs, project working directories and browser control/takeover.
- Hermes mode adds Fleet/bots, Crew, Automations, Skills, Connectors and Inbox.
- Four app languages: English, Arabic with RTL, Chinese and French.
- Local notifications; OTA JS updates; Android CI APK releases.

### Network truth

“Local-first” describes the agent/control plane, not a guarantee of zero network traffic. Hosted model inference, OpenCode’s free hosted models, Linux/OpenCode downloads, package installation, model catalogs, OTA, Expo/FCM push registration, web browsing, web search, remote MCP servers and terminal commands may use the internet. No local model weights are bundled.

### Runtime guarantee in scope

This work adds a guard so a saved non-loopback configuration from the remote era cannot be retried as a remote gateway. The normal path already boots the embedded loopback gateway. This guard does not block model providers, downloads, OTA, push or arbitrary browser/terminal network access.

### Release and platform constraints

- The local-first/OpenCode story applies to current CI builds, not stable v1.0.0.
- OpenCode one-shot mode has no token streaming or interactive permission cards.
- No iOS release is currently offered.
- Existing `docs/screenshots/*.png` are pre-redesign Hermes-era captures. They must be labeled as legacy or replaced; never present them as the current OpenCode UI.

## Brand Commitments

- Product name: **Moch**.
- Keep the existing Moch logo and Mochi mascot assets.
- Keep the friendly consumer system: Mocheme near-black indigo, antenna orange, cream, soft rounded shapes, plain language and no emojis.
- Do not turn the site into a terminal/code-editor aesthetic. Developer details may appear in supporting sections, not as the visual world.
- Beginning-friendly tone: every technical term gets a one-line human explanation.
- The redesign is mobile-first and may replace the current page composition, navigation and component system while preserving these brand commitments.

## Evidence on Hand

- `docs/assets/logo.png` and `docs/assets/favicon.png`.
- `docs/assets/moch/*.svg` mascot artwork.
- `docs/redesign/design.html` as an app-UI reference, not a production website template.
- Current code paths for embedded boot, OpenCode, onboarding and network behavior, recorded in `docs/SITE-SPEC.md`.
- Current CI pre-releases on GitHub.
- No testimonials, customer counts, benchmarks or independent privacy audit. Do not fabricate them.

## Product Principles

1. Plain words first; explain Hermes and OpenCode as choices, not prerequisites.
2. The agent/control plane runs on the phone; the model provider is the user’s choice.
3. Prove the product with real UI and concrete setup steps, not abstract claims.
4. Be explicit about beta status, thinker differences and network use.
5. Mobile first: one-handed navigation, legible type, 44px targets, no horizontal overflow and reduced-motion support.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the site: semantic landmarks and headings, keyboard-operable navigation and copy controls, visible focus, sufficient contrast, 44px minimum touch targets, responsive reflow at 320px, 200% zoom support, respectful motion and clear error/fallback states.
