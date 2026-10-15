> ## SUPERSEDED — 2026-10-15. Do not implement this document.
>
> This file records the **abandoned step-1 approach**: wrapping the phone's
> Expo web export in a **420x860 phone-shaped window** running **linked mode**
> through the relay. It contradicts the current app and the current plan on
> the fundamentals:
>
> - The desktop now runs the **REAL app screens** (`app/app/**`) and the real
>   `app/src/lib` logic in the Tauri webview via **react-native-web**, against
>   the **local runtime** — not a web export in a phone-sized window.
> - The desktop owns only the native shell, a desktop presentation layer, and
>   the local runtime + packaging; **no business/protocol logic may live in
>   the desktop tree**.
> - `desktop/ui/` — the hand-written parallel UI built after this doc — is
>   **frozen** and is being migrated screen by screen into the shared core.
> - Its window assumptions (420x860, min 360), its linked-mode framing, and
>   its line references no longer match this branch.
>
> The authoritative document is
> [desktop/ARCHITECTURE.md](desktop/ARCHITECTURE.md) (decision, layers,
> P0-P6 roadmap); the parity debt is tracked in
> [desktop/PARITY-BACKLOG.md](desktop/PARITY-BACKLOG.md). The body below is
> kept verbatim for history.

# FEATURE-DESKTOP-TAURI.md — Moch Desktop (Tauri 2), step 1: the proof

> Branch `desktop-tauri` (worktree `worktrees/desktop-tauri`), off `main` @
> 63c8d0c. Everything lives in `desktop/` — zero changes to `app/`,
> `moch-link/`, `relay/`. Doc written 2026-10-14 after a two-agent
> read-only verification pass; see "Verification" below.

## What landed

A lightweight desktop shell: **Tauri 2** window (Rust, system webview —
webkit2gtk on Linux, WebView2/WKWebView elsewhere) that loads the **Expo
web export** of the Moch app and runs **linked mode** — the same
`wss → relay → moch-link → hermes serve` path the phone uses.

```
desktop/
  package.json        @tauri-apps/cli + scripts (export:web → tauri dev/build)
  src-tauri/          the shell: Cargo.toml, tauri.conf.json, capabilities/, icons/
  web/                (gitignored) expo export --platform web output
```

- `npm run export:web` → `cd ../app && npx expo export --platform web
  --output-dir ../desktop/web` — no app changes needed; nothing in `app/`
  is touched or committed.
- Window: 420×860 phone layout, `minWidth 360`; CSP allows `ws:/wss:`
  (relay) — `connect-src` is the only security surface widened.
- Release profile: `opt-level="s"`, LTO, single codegen unit, strip.

## Why Tauri 2 (and not Electron/RN-Desktop)

- **Lightweight**: system webview, no bundled Chromium; debug binary aside,
  release ships a few MB and a fraction of Electron's RAM.
- **No RN-Desktop**: no maintained Linux target (we're on omarchy), and it
  would mean writing another HermesBridgeModule per platform.
- The app's TS protocol stack is transport-agnostic and the UI already runs
  on `react-native-web` — the shell has almost nothing to do.

## Verification (step-0 pass, two read-only agents)

Both agents returned **PARTIAL** — the core holds, the edges don't:

### A. Web-export readiness — no breakers

- Every audited native-module risk is web-safe: `react-native-webview`
  falls back to an inert component on web ([AgentBrowserHost.tsx:40]
  imports it at module scope but renders null on web); expo haptics /
  secure-store / audio / camera / clipboard / speech / file-system all
  ship `.web.js` variants; `expo-notifications` is only lazy-required
  ([push.ts:136](app/src/lib/push.ts#L136)); keyboard-controller and
  reanimated are web-supported no-ops; `NativeModules.HermesBridge`
  ([mochiRuntime.ts:52](app/src/lib/mochiRuntime.ts#L52)) reads undefined
  and is guarded.
- Web mode was exercised in the initial-commit era — `app/README.md:9`
  documents "the web build at phone size, connected to a real gateway"
  with 9 screenshots (pairing, chat streaming, markdown, sidebar, models,
  automations, skills, settings).
- Correction filed by the agent: `TEST-1.0.1*-browser.md` and
  `BROWSER-SPEED-REPORT.md` are about the **in-app agent Browser screen**,
  NOT the app on web — don't cite them for web mode.

### B. Gateway/relay over a webview origin — core green, HTTP edges blocked

Works unchanged in the webview:

- **WS dial**: [rn-socket.ts:27-37](app/src/protocol/rn-socket.ts#L27-L37)
  wraps the global `WebSocket`. Browsers can't send custom WS headers →
  the relay 401s the header-mode first dial → [gateway.ts:664-679]
  already retries with legacy `?token=` query, which the relay accepts
  ([moch-relay-server.js:457](relay/moch-relay-server.js#L457)). One
  wasted RTT per connect, benign.
- **Token persistence**: SecureStore → AsyncStorage fallback
  ([gateway.ts:196-239](app/src/lib/gateway.ts#L196-L239)); on web that's
  `localStorage` in the webview.
- **Camera-free pairing**: [PairForm.tsx:185-245] "More options" — paste a
  `hermes://connect?host=…&token=…` link or enter host + token + TLS
  checkbox manually. `hermes://` deep links do NOT fire from a webview;
  always pair via the manual path on desktop.
- **No Origin/CORS on the WS path**: the relay never reads Origin;
  moch-link's proxy rewrites Host+Origin to `127.0.0.1` in front of
  `hermes serve`, so the home's WS origin guard never sees the webview
  origin.

## Known gaps on desktop (deferred, with fix outlines)

Verified blockers for **plain-HTTP `/api/*`** (media viewer, file
download/stream, voice STT/TTS, MCP catalog) — chat text/pairing/
streaming are unaffected:

1. **Relay preflight 401** — CORS preflight `OPTIONS /api/*` carries no
   custom headers → dies at the relay's token gate
   ([moch-relay-server.js:459](relay/moch-relay-server.js#L459)). *Fix:
   answer `OPTIONS /api/*` directly with CORS headers before the token
   gate, and inject `Access-Control-Allow-Origin` into spliced `/api/*`
   response heads.*
2. **hermes serve CORS regex is localhost-only**
   (`^https?://(localhost|127\.0\.0\.1)(:\d+)?$`,
   [web_server.py:390](app/hermes-src/hermes_cli/web_server.py#L390)) and
   moch-link-proxy rewrites the request Origin to `127.0.0.1`, so the
   allow-listed origin never matches the page's `http://tauri.localhost`.
   *Fix in moch-link-proxy: remember the pre-rewrite Origin and patch
   `Access-Control-Allow-Origin` in the response head.*
3. **Media display/upload is web-broken independent of CORS** —
   expo-image/expo-video render `<img>/<video>` which can't send auth
   headers ([mediaCache.ts:34-55](app/src/lib/mediaCache.ts#L34-L55));
   `FileSystem.uploadAsync` is unimplemented on web
   ([mediaSend.ts:130](app/src/lib/mediaSend.ts#L130)). *Fix: signed-URL
   GETs or WS-routed media; `fetch`+blob uploads on web.*
4. **Push/knocks absent** — no Expo token on web; notifications silently
   no-op ([push.ts:589](app/src/lib/push.ts#L589) gates on
   isPhysicalDevice). *Step 3: native notifications via the shell.*
5. **Embedded mode is Android-only** — `setup.tsx` "Use this phone"
   fails gracefully on web. Desktop *is* the machine hermes runs on; the
   answer is step 2 (local mode), not porting Chaquopy/proot.
6. Browser/Terminal screens show the inert "WebView does not support this
   platform" fallback on web (expected; CDP relay is Android-native).

## How to run (proof)

```sh
cd worktrees/desktop-tauri/desktop
npm install                    # @tauri-apps/cli only
npm run export:web             # expo static web export → desktop/web
npx tauri dev                  # debug window; or: npm run build → AppImage/deb
```

Pair with: Settings → Add a computer (or onboarding) → **More options**
→ paste the pairing link (or host `api.moch.softland.tech` + token +
HTTPS/WSS checkbox).

First-run evidence (2026-10-14, this machine): export exit 0; `cargo
build` green; window opened under Hyprland (wayland), webview rendered
the dark theme + brand palette (verified by screenshot color analysis —
near-black `#0A0813` background, orange `#BC7F58` accents, 2800+ unique
colors; not a blank/fallback page).

## Roadmap

- **Step 2 — local mode (the real desktop story):** shell supervises
  `hermes serve` on 127.0.0.1 (spawn / health-poll / restart), session
  token in the OS keyring, gateway dials `ws://127.0.0.1` like any linked
  computer. No relay, no moch-link needed locally.
- **Step 3 — desktop polish:** tray + close-to-tray, quick-ask global
  hotkey, native notifications for knocks, drag-drop media, multi-pane
  layout (sidebar + chat side-by-side), Tauri updater.
- **Maybe:** fix the two CORS blockers above in `relay/` + `moch-link/`
  so remote linked mode gets media/voice too (they're server-side fixes,
  independent of the shell).
