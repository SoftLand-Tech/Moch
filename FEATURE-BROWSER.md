# Moch Browse — a real browser the agent drives, on your screen

Research: `research/` (5 reports, Oct 2026) · this doc is the synthesis + build plan.

## Why this feature

Moch is already a harness in your pocket — terminal, files, automations. The one
harness-grade surface missing is the browser: today the agent can `web_search` /
`web_extract`, but it can't *operate* the web — click, fill, log in, buy, book,
fill forms, read what's behind auth. And every consumer agent that does this
either runs the browser **in the cloud** (ChatGPT agent, Comet iOS, Rabbit) or
**is the OS vendor** (Apple, Honor). Nobody runs a real, visible, on-device
agentic browser. Comet on iOS couldn't — WebKit gave them no in-app control
surface, so they fell back to a cloud VM with cookie transfer. Android's
WebView *does* expose a control surface. That's the opening.

## The idea in one line

**A real, visible, multi-tab Chromium (the system WebView) rendered inside
Moch, driven by the embedded hermes over the same Chrome DevTools Protocol the
desktop harnesses use — the user watches every tap, and can grab the wheel at
any moment.**

Not headless. Not a cloud VM. Not an a11y hack. The browser the agent drives
is the browser on your screen.

## What the research says (5 subagent reports, all primary-sourced)

1. **The transport is real and proven** — `research/webview-cdp-report.md`
   - `WebView.setWebContentsDebuggingEnabled(true)` starts a DevTools server
     *inside the app process* on abstract unix socket
     `webview_devtools_remote_<pid>` (Chromium `aw_devtools_server.cc`).
   - **Your own app may connect to its own socket.** The peer-auth check
     (`devtools_auth.cc`, `SO_PEERCRED`) admits root, adb, and same-UID
     processes — i.e. the Chaquopy Python runtime, same process, same UID.
     Other apps are refused. This is the load-bearing fact.
   - CDP per-WebView page targets support DOM, DOMSnapshot, Accessibility,
     Runtime, Network, Fetch, `Input.dispatchTouchEvent`, screenshots,
     screencast. Limits: **no browser-level target** (tab create/close must
     be native UI), no contexts, keep WebViews attached (never detached).
   - Proven in the wild: `jan5lo7o/android-webview-cdp` drives a WebView by
     CDP from on-device Termux; Puppeteer-verified on Android 16. Playwright
     `connectOverCDP` works against an http endpoint.
2. **The agent loop is a solved pattern** — `research/agentic-browser-frameworks.md`
   - browser-use / Playwright MCP / Claude browser toolset converge on: pruned
     viewport-visible interactive tree with refs → one JSON decision (≤5
     actions, page-changing last, fail-fast) → re-observe → `done(text)`.
   - Grounding: CDP `DOMSnapshot.captureSnapshot` + `Accessibility.
     getFullAXTree` merged (browser-use's current production approach).
     Licenses all MIT/Apache-2.0 — pattern reimplementation is clean.
3. **The engine choice is forced** — `research/mobile-agent-surfaces.md`
   - CDP-on-own-WebView beats AccessibilityService (Play-declaration risk),
     Appium/UiAutomator/Maestro (need adb), cross-app Chrome CDP (SELinux
     blocks), GeckoView (no CDP — Marionette/BiDi only), CEF (no Android),
     Custom Tabs (no DOM access), headless (rejected by design).
4. **Anti-bot & logins are manageable** — `research/webview-browser-agent-report.md`
   - `X-Requested-With` gone since WebView 110; TLS/JA4 + WebGL match Chrome;
     CDP input is `isTrusted=true` (real input pipeline). Persistent tells:
     UA `;wv` token (strip once at startup, never mid-session) and
     `Sec-CH-UA` "Android WebView" brand (unfixable, forbidden header).
   - Turnstile officially supports WebView (JS + storage + stable UA).
     CAPTCHA pattern: agent pauses, human solves in the same view.
   - Google OAuth is hard-blocked in embedded WebViews → Custom Tabs /
     Credential Manager handoff. Passkeys: androidx.webkit 1.12
     `setWebAuthenticationSupport()` opt-in.
   - Play policy: in-app browser + in-app CDP needs **no special declaration**
     (no AccessibilityService involved).
5. **The market gap is real** — `research/agentic-browser-landscape-2026.md`
   - Comet is the only agentic browser on Android (Nov 2025); Atlas killed
     (Aug 2026), Mariner killed (May 2026), Arc abandoned. Mobile agentic
     browsing is near-greenfield, and on-device is unclaimed.

## How it works

```
┌─ RN UI ───────────────────────────────────────────────────────────────┐
│ Browser screen: tab strip · URL bar · page = real <WebView>s          │
│ Agent chat = bottom sheet over the page · step timeline · confirm     │
│ cards · any user touch on the page = instant takeover                 │
└──────────────┬────────────────────────────────────────────────────────┘
               │ owns tabs (native lifecycle — CDP can't create targets)
┌──────────────▼───────────────┐   abstract unix socket (same-UID only)
│ Kotlin BrowserTabsModule     │◄──────────────────────────────┐
│  · N WebViews, kept attached │                               │
│  · setWebContentsDebugging…  │   ws://…/devtools/page/<id>   │
│  · onRenderProcessGone reset │                               │
└──────────────┬───────────────┘                               │
               │ /json/list ⇄ tabs↔targets registry            │
┌──────────────▼───────────────┐   ┌────────────────────────────┴────────┐
│ HermesBridge (typed methods, │   │ hermes (embedded, Chaquopy CPython) │
│ no shell passthrough)        │──▶│  tools/browser_supervisor.py        │
└──────────────────────────────┘   │  websockets.connect(BROWSER_CDP_URL)│
                                   │  browser_navigate/click/type/…      │
                                   │  snapshot · vault · dialogs         │
                                   └─────────────────────────────────────┘
```

- **Engine**: system WebView = real Chromium, hardware-accelerated, real
  cookies (`CookieManager.flush()`), persisted profile via
  `setDataDirectorySuffix` / androidx.webkit ProfileStore → agent tabs get an
  isolated profile, user tabs (later) get their own.
- **Control**: hermes already speaks raw CDP — `browser_supervisor.py` does
  `websockets.connect(cdp_url)`, and `websockets==15.0.1` is already in
  `app/python-runtime/requirements-embedded.txt`. The attach mode already
  exists: `browser.cdp_url` / `BROWSER_CDP_URL` skips local launch and cloud
  and attaches to any CDP endpoint.
- **The one new wire**: Chaquopy Python connects to
  `\0webview_devtools_remote_<pid>` (abstract unix, same process ⇒ SO_PEERCRED
  passes; `websockets.unix` / asyncio support abstract sockets on Linux).
  Vendored `hermes-src` gets a small patch: a `webview://` pseudo-scheme in
  `_resolve_cdp_override` + unix-socket connect in the supervisor + a
  per-task page-target selector (it currently attaches "first page target";
  with N tabs it must attach *the task's* tab). Fallback if abstract-socket
  connect from Chaquopy hits a wall: tiny Kotlin loopback TCP relay (must
  add its own token auth — loopback TCP is reachable by other apps, unlike
  the unix socket).
- **Observation**: DOMSnapshot + AX merge (browser-use's production method),
  pruned to viewport-visible interactive elements, `[eN]` refs, `*` new,
  scroll markers, ~50k cap — hermes' snapshot post-processing
  (`browser_tool_snapshot.py`: redaction, spill-to-file, screenshot recovery)
  already handles the edges.
- **Action**: CDP `Input.dispatchTouchEvent` / `insertText` — taps land in
  the *real* input pipeline (`isTrusted=true`), on the screen, in front of
  the user. Humanized curves later; v1 plain dispatch.
- **Tabs**: owned by RN/Kotlin (`Target.createTarget` doesn't exist for
  WebViews) — a tabs⇔targets registry synced from `/json/list` polling;
  hermes tools get tab switch via bridge call, not CDP.
- **Agent surface — already in the APK**: `browser_navigate, snapshot, click,
  type, scroll, back, press, get_images, vision, console, cdp, dialog` +
  login vault (`browser_vault_unlock/fill/save_login/enter_code`). The
  availability gate (`browser_tool_install.py`) needs a "webview backend"
  branch so tools advertise on-device. Chat already renders tool rows
  (`Chat.tsx:398`); screenshots ride the existing media path.

## UX (from the landscape report, mobile-first)

1. **In-page visible agent + instant takeover** — the page is the watch view;
   any user touch pauses the agent and hands over control (Comet Android's
   pulsing-highlight pattern, Brave's "never hidden" rule).
2. **Chat as a bottom sheet over the page**, not a sidepanel (phones).
3. **Step timeline** — URL + thumbnail + action per step; doubles as an audit
   log the agent can't delete.
4. **Confirmation cards** for consequential actions only (purchase, PII
   submit, login, delete): bottom sheet with site + exact diff → Approve /
   Cancel. No per-site nagging (warning fatigue killed others).
5. **CAPTCHA pause-and-solve**: agent stops, sheet says "Cloudflare needs a
   human", user solves in the same view, agent resumes.
6. Later: background task queue on the existing foreground service +
   knocks (M6/M7 machinery), voice tasking, recipes ("book again"),
   replay/share a run.

## Safety & anti-bot (checklist form)

- Devtools socket enabled **only during live agent sessions** (it exposes
  page contents to an adb-attached PC / root — same trust level as USB
  debugging; user opt-in, documented).
- Domain policy engine outside the LLM: default-deny banking/payments/gov/
  health eTLD+1; per-task allowlists; re-classify on navigation; abort on
  class change mid-form.
- Secrets via vault placeholders — model sees `x_username`, executor injects
  the real value; never screenshots during credential entry.
- Prompt injection is *the* threat (InjecAgent: 24% ASR on ReAct GPT-4):
  page content enters prompts only as quoted data in a rigid schema;
  strip hidden/white-on-white text from snapshots; exfil checks on submits;
  confirmation gates are structural, not prompt-level.
- UA: strip `;wv` once at startup, never mid-session (Turnstile requires
  consistency). Require WebView ≥110. Cookies persist across runs (aged
  cookies → fewer challenges). Hardware accel always on.

## Milestones

- **B0 — Spike (the proof)**: one test screen with a `webviewDebuggingEnabled`
  WebView; from Chaquopy, connect to `\0webview_devtools_remote_<pid>`, GET
  `/json/version`, open the page ws, `Page.navigate` + one
  `Input.dispatchTouchEvent`. Acceptance: an agent tool call visibly taps a
  button in a real page. (Everything after this is plumbing.)
- **B1 — Browser shell**: tabbed browser screen (RN WebViews kept attached,
  ≤2–3 live), URL bar, progress, tabs⇔targets registry, isolated agent
  profile, `webview://` patch in vendored hermes, `BROWSER_CDP_URL` wired,
  browser tools advertised in the embedded runtime.
- **B2 — Agent polish**: mobile-tuned snapshot pruning (viewport-first,
  refs, scroll markers), dialog handling, screenshots into chat, step
  timeline UI, take-over-on-touch.
- **B3 — Trust layer**: confirmation cards, domain policy engine, vault
  fill/save, OAuth via Custom Tabs handoff, CAPTCHA pause UX, devtools
  socket session-gating.
- **B4 — Background & voice**: task queue on foreground service + knocks,
  recipes, replay/share, humanized input curves.

## Deliberately v1

- Android only (iOS has no CDP; `WKWebView.inspectable` is WebKit-Inspector,
  not CDP — a JS-bridge backend is a separate, later project).
- No user-vs-agent profile split UI; one isolated agent profile.
- No cross-app mode (AccessibilityService) — future, gated on Play
  declaration/review appetite.
- DOM-first grounding; vision (SoM screenshots) for canvas/verification only.

## Risks / open questions

1. Abstract-socket connect from Chaquopy unverified on-device → B0 settles
   it; Kotlin loopback relay is the fallback (needs token auth).
2. hermes supervisor is single-target ("first page") → patch to per-task
   target selection (vendored source, we own it).
3. CDP surface drifts with the installed WebView version → feature-detect
   via `/json/version`; keep `evaluateJavascript` as plan B for observation.
4. Background tabs: rendering throttles off-screen; DOM/CDP still work,
  screenshots degrade — B4 needs the foreground-activity watch model.
5. WebView memory: cap live tabs, destroy + snapshot-restore background ones.
6. Residual anti-bot tells (`Sec-CH-UA` brand) — accepted; "agent got
   challenged" is a normal, communicated outcome (pause-and-solve).

## Rollback

Additive: browser screen + tab module + relay/patch behind a flag; remove
the flag and the feature disappears — hermes' browser tools fall back to
cloud/local backends exactly as today.

## Research index

- `research/webview-cdp-report.md` — WebView CDP internals, SO_PEERCRED
  auth, capabilities/limits, prior art, alternatives table, 18 sources.
- `research/agentic-browser-frameworks.md` — browser-use / Playwright MCP /
  Claude toolset / Stagehand loop + grounding spec, licensing, 13 sources.
- `research/mobile-agent-surfaces.md` — a11y vs CDP vs vision matrix,
  Play policy, SELinux cross-app analysis, 15 sources.
- `research/webview-browser-agent-report.md` — anti-bot, logins/passkeys,
  injection defenses, on-device vs cloud LLM split, 25 sources.
- `research/agentic-browser-landscape-2026.md` — product landscape, UX
  patterns, user complaints, 24 sources.
