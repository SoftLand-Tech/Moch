# Moch local-first site + identity contract

This is the shared contract for the single `feat/local-first-site-identity` PR. Product truth lives in [`PRODUCT.md`](../PRODUCT.md); this file owns the site, copy, runtime-guard and release boundaries for this change.

## 1. Identity copy

### Approved primary copy

> **Moch — your agent runs on your phone. Your model is your choice.**

Supporting line:

> An open-source AI workspace with Hermes built in and OpenCode inside an optional Ubuntu Linux guest. No Moch account, relay or remote gateway required.

Required caveat, visible near the first privacy/local claim:

> Local-first means the agent and your workspace live on the phone. Hosted models, OpenCode’s free hosted models, downloads, OTA updates, web browsing and optional services can still use the internet. Connect a local model for on-device inference.

### Approved short/technical copy

> Moch is a local-first Android agent workspace. Hermes runs embedded; OpenCode runs inside Moch Linux. Both use on-device control planes. Bring a hosted provider or a local model.

### Thinker explanation

- **Moch (Hermes):** the default, full feature set — chat, projects, Fleet/bots, Crew, Automations, Skills, Connectors, Terminal and Browser.
- **OpenCode:** an optional coding-agent thinker inside Moch Linux — Chat, Projects/OpenCode sessions, Terminal, Browser and Settings. Hermes-only surfaces are hidden.
- Existing chats keep the thinker they were created with. Switching thinker affects new chats.

### Release truth

- Current development build: **1.0.53-beta.2, versionCode 57**.
- Stable **v1.0.0** is the legacy linked/relay build. Label it clearly; never link it as the current local-first download without that warning.
- Primary download CTA: `/Moch.apk`, labeled **Download the current beta**.
- Secondary link: GitHub Releases for build history and checksums.

### Prohibited or misleading claims

Do not publish any of these without qualification:

- “Fully local, no remote at all” / “nothing ever leaves your phone.”
- “OpenCode is the default” / “the official OpenCode app.”
- “OpenCode is bundled in the APK.” It is integrated and downloaded into Moch Linux on first use.
- “Free models are on-device.” OpenCode free models are hosted; free means no key/account.
- “No accounts, no monthly fee” without “no Moch account or Moch subscription”; model providers may require accounts and charge usage.
- “Knocks land even if the app was killed.” Current local knocks depend on the runtime/process surviving.
- “Expo Go is equivalent to the APK.”
- “Fleet, Crew and Automations work in OpenCode mode.”
- “The current stable APK includes embedded mode or OpenCode.”

## 2. Audience and brand

- Primary audience: general local-AI users; secondary: developers already using OpenCode.
- Keep Moch, the real logo and Mochi mascot.
- Keep the friendly consumer Mocheme world: near-black indigo, antenna orange, cream, soft shapes, no emojis, no terminal/editor aesthetic.
- Full redesign applies to composition, navigation, hierarchy, mobile behavior and component system—not a rename or mascot replacement.
- Plain language first. Explain “thinker” as “the brain that answers,” and “Linux guest” as “a little Ubuntu computer inside the app.”

## 3. Site content contract

`docs/index.html` must cover, in this order unless the approved comp improves it without losing content:

1. **Hero:** approved headline, one-sentence explanation, primary beta download, secondary setup CTA, real Moch/Mochi artwork, one proof line.
2. **On-device proof:** a concrete local-runtime diagram or product UI illustration showing Phone → Moch runtime → Hermes or OpenCode → chosen model. Label model/network boundary honestly.
3. **How it works:** Download beta → open app → install/skip Linux → choose Hermes or OpenCode → connect provider/local model → chat.
4. **Choose your thinker:** two clear cards with feature differences and the “existing chats keep their thinker” note.
5. **What you can do:** chat/reasoning/tools, projects, terminal, browser control, and Hermes-only Fleet/Crew/Automations clearly separated.
6. **Local-first, honestly:** the required network caveat, no Moch account/relay/remote gateway in the standard CI path, stable-vs-beta warning.
7. **Setup CTA:** link to `setup.html` and `/Moch.apk`.
8. **FAQ:** Android/iOS/Expo Go, Linux requirement, local models, hosted models, OpenCode installation, stable-vs-beta, legacy relay users.
9. **Footer:** MIT, GitHub, setup, current beta/version, no fake metrics/testimonials.

`docs/setup.html` must document the actual first-run flow:

1. Download the current CI beta.
2. Environment: install Ubuntu 24.04 (default) or skip; OpenCode requires Linux.
3. Thinker: Moch (Hermes, default) or OpenCode.
4. Providers: Hermes key or OpenCode hosted/local provider; OpenCode free hosted models need no key but use the network.
5. About you, notification and battery permissions.
6. Troubleshooting and a clearly separated **Legacy v1.0.0 / moch-link relay setup** section for existing users only.

## 4. Design and implementation contract

- Static HTML/CSS/vanilla JS only. No framework, bundler, npm dependency or build step.
- Mobile-first CSS: base styles for 320–390px, then `min-width` enhancements for tablet/desktop.
- No third-party font, analytics, CDN script or tracking request. Use system fonts or locally hosted font files with provenance.
- Shared `docs/site.js` owns mobile navigation, copy buttons, FAQ details/polyfills if needed, current year and download metadata. No duplicated inline scripts.
- Required semantics: one `h1` per page, labelled nav, buttons for actions, links for navigation, visible focus, skip link, `aria-expanded` on menu controls.
- Required ergonomics: 44px minimum targets, safe-area insets, no horizontal overflow, sticky anchors clear the header, landscape reflow, 200% zoom, `prefers-reduced-motion`.
- Required metadata: canonical URL, Open Graph and Twitter card, theme color, descriptive title/description, favicon and a 1200×630 social image.
- Preserve working `/Moch.apk`, `setup.html`, `install.sh` and asset URLs or update every reference atomically.
- Replace the current visual composition rather than polishing the old hero/card grid. The approved comp is the spatial authority.

## 5. Asset contract

- Reuse `docs/assets/logo.png`, `docs/assets/favicon.png` and `docs/assets/moch/*.svg`.
- Do not use existing `docs/screenshots/*.png` as current product UI. They are legacy Hermes captures. Replace with fresh captures or clearly labeled illustrative UI built from current app tokens.
- Any generated raster ships with provenance: prompt, model/tool, date and intended use. Any sourced asset ships with origin/license.
- Social image: `docs/assets/og-image.png`, 1200×630, real Moch branding, approved headline, no fabricated metrics.
- Optimize images; specify width/height to avoid layout shift.

## 6. Runtime local-only guard contract

Scope: legacy remote-retry behavior only.

- Normal boot continues to call `connectThisPhone()` and dial the embedded loopback gateway.
- A saved configuration whose normalized host is not loopback may be retained for migration/cache identity but must not be passed to `dial()` by `retryNow()` or another legacy retry path.
- Prefer a pure, testable guard in the existing transport/gateway layer; do not rewrite pairing/history code.
- Preserve explicit local hosts: `127.0.0.1`, `localhost`, `[::1]` and the embedded gateway port.
- Add offline tests proving: local retry works; non-loopback retry is refused; normal embedded boot is unchanged; error copy is actionable.
- Do not claim this blocks model providers, OTA, push, browser/terminal network access or remote MCP. It only prevents the retired remote-gateway retry path.

## 7. GitHub/product-copy contract

Update these owned files:

- `README.md`
- `app/README.md`
- `app/app/README.md` (replace duplicate stale content with a pointer if appropriate)
- `app/PRODUCT.md` and `app/app/PRODUCT.md` (align with root product truth)
- `desktop/README.md`, `desktop/FEATURES.md`, `desktop/src-tauri/Cargo.toml`, `desktop/install.sh` (local control plane, Hermes-only, no false “nothing leaves” claim)
- `moch-link/README.md`, `relay/README.md` (prominent legacy/stable-v1.0.0 context)
- `SECURITY.md` (clarify local CDP relay versus retired remote relay)

Server-side metadata to apply after merge:

- Description: **Moch — your agent runs on your phone. Hermes built in, OpenCode in an on-device Linux workspace.**
- Homepage: `https://moch.softland.tech`
- Topics: add `opencode`, `local-first`, `on-device-ai`, `android`, `hermes-agent`, `ubuntu`, `proot`; remove `self-hosted` and `websocket` from the primary identity if they are no longer lead terms.
- Social preview: generate `docs/assets/og-image.png`; GitHub’s API does not expose social-preview upload, so leave a clear manual-upload step unless a supported API is found.

## 8. Release/deploy/QA contract

- Public publish allowlist: `index.html`, `setup.html`, `moch.css`, `site.js`, `install.sh`, `assets/**`, and only approved current screenshots/illustrations. Keep `/Moch.apk` in place.
- Never publish `docs/redesign/**`, `docs/bug-hunter/**`, `docs/screens-inventory.html`, `docs/SITE-SPEC.md`, tests or source maps.
- Add a site verification script under `docs/tests/` or `scripts/` that checks HTML structure, internal links/assets, required copy/caveats, metadata, installer sync and forbidden deployment paths.
- Add a deploy workflow that runs on changes to the allowlist, verifies first, then deploys only if the repository’s SSH secrets are configured. If secrets are absent, skip deployment with a clear log; never fail the APK/OTA workflow because site deploy is unconfigured.
- Update Android CI release notes to name the local-first identity and link the site/setup guide.
- Preserve `moch-link/install.sh` and `docs/install.sh` byte identity unless both are deliberately changed together.

## 9. Verification gates

Run before review:

```bash
git diff --check
python3 app/python-runtime/tests/test_docs_sync.py
bash -n moch-link/install.sh
bash -n docs/install.sh
node <site-verification-script>
```

Site screenshots/checks: 320, 360, 390, 768, 1024 and 1440px; landscape; 200% zoom; keyboard focus order; 44px targets; no horizontal overflow; clipboard fallback; reduced motion; no third-party requests.

Runtime guard:

```bash
cd app
npm run typecheck
npm run lint
npm run test:gateway-logic
npm run test:pairing
npm run test:relay
npm test
```

Do not run `npm run verify` as the docs/site gate; it includes live-gateway tests.

## 10. Commit order for the combined PR

1. `docs: capture local-first product and site contract`
2. `fix: block legacy remote gateway retries`
3. `feat: redesign mobile-first local-first website`
4. `docs: align GitHub and product identity`
5. `ci: verify and deploy the website safely`

Each commit must be independently reviewable. The final PR body links the approved comp and lists the verification evidence.
