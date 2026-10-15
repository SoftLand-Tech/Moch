# Moch Desktop (Tauri 2) — local-only PC build

**Your own hermes agent, on your PC — through Moch, not through hermes.**
The desktop twin of the phone's embedded mode: the app runs its OWN agent
runtime (the fork, in a Moch-owned home) and a fresh web UI talks to it
over loopback with the app's TypeScript protocol stack, imported verbatim.

## Status (2026-10-15)

This README describes `desktop/ui` — the hand-written fork of the phone UI.
That fork is now **frozen** (see [ui/FROZEN.md](ui/FROZEN.md)) and the
desktop is moving to the phone app's real screens rendered via
react-native-web. The authoritative document is
[ARCHITECTURE.md](ARCHITECTURE.md); the parity debt is in
[PARITY-BACKLOG.md](PARITY-BACKLOG.md). Until they land, read the claims
below with these corrections:

- **"token redacted from logs + config" (Rounds table, audit row) is false
  for config.** Logs: true — the shell filters token-bearing lines
  (`line_carries_token` in `src-tauri/src/lib.rs`). Config: false — the shell
  serves the live token verbatim to any local reader at
  `GET /moch-config.json` (handler in `src-tauri/src/lib.rs:557-563`; the
  served `cfg` embeds `"token": token`, `src-tauri/src/lib.rs:702-705`).
  That endpoint is how the UI boots; "redacted from config" is not what the
  code does.
- **`MOCH_SELFTEST=1` — "autonomous round trip on every tab's RPCs"
  overstates it.** The selftest effect (`ui/src/App.tsx:261-291`) covers
  only 7 read RPCs (`session.list`, `profiles.list`, `moch.fleet.status`,
  `moch.skills.list`, `cron.manage`, `moch.kanban.tasks`, `model.options`,
  at `App.tsx:277-283`) plus `session.create` + one `prompt.submit`
  (`App.tsx:284-286`). Nothing from the Bots/Crew/Automations/Skills/Browser
  write paths, and `desktop/.dbg.log` currently contains 0 selftest lines
  (checked 2026-10-15).
- **"The UI is EMBEDDED in the binary" is true only for fresh `target/`
  builds.** The SHIPPED deb/AppImage embed a stale bundle: the AppImage
  binary contains `index-Bxg3r1Gs.js` (via `strings`), while today's build
  is `web-ui/assets/index-DgiOoQ5x.js`. Rebuild before shipping anything.
- **The deb/AppImage cannot run without the repo checkout.** "The lightweight
  installable" oversells it: the bundles contain only the binary — no
  `runtime.py`, no hermes fork, no Python — and runtime discovery falls back
  to machine-baked absolute paths (e.g. the hardcoded venv python in
  `src-tauri/src/lib.rs` python discovery). "Known limits" below says this;
  the "Bundles (built)" framing does not.
- **`desktop/ui` is frozen.** The Rounds table below is the fork's history,
  not the product roadmap; new work goes to the shared layer
  ([ARCHITECTURE.md](ARCHITECTURE.md) hard rule).

```
┌ Tauri shell (Rust) ────────────────────────────────────────────────┐
│ RUNTIME: spawns the phone's own gateway module as a supervised     │
│  child (desktop/runtime.py → app/python-runtime/moch/              │
│  gateway_server.py): headless serve, MOCH_FLEET=1 (bots/crew       │
│  surface — BUG-109), in-process slash worker, fleet admission      │
│  gate, dm bridge, HERMES_DESKTOP=1 cron ticker.                    │
│  Home: desktop/runtime-home (HERMES_HOME) — app-private, like the  │
│  phone. Handshake: .moch-gateway.json (file-based). SIGTERM kills  │
│  the child. Attach to an external serve only via MOCH_ATTACH=1.    │
│ SERVER: serves the built UI + /moch-config.json + /setup.json on   │
│  127.0.0.1:<port> — loopback origin the gateway's guard accepts.   │
│ WINDOW: loads that origin. GDK_BACKEND=x11 default on Linux        │
│  (WebKitGTK fractional-scale crop bug on Wayland).                 │
│  ┌ UI (Vite+React, desktop/ui → web-ui) ─────────────────────────┐ │
│  │ JsonRpcGatewayClient — the app's protocol stack, unchanged    │ │
│  │ First-run wizard: welcome → boot → provider key → done        │ │
│  │ Tabs: Chat · Bots · Crew · Automations · Skills · Models ·    │ │
│  │       Browser · Run                                           │ │
│  └───────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

## Agent browser

runtime.py spawns a **Moch-owned Chromium** (`--remote-debugging-port`,
fresh `--user-data-dir` under the runtime home) BEFORE the gateway boots
and publishes `BROWSER_CDP_URL` — the exact env the agent's browser tool
layer reads (`tools/browser_tool_cdp.py`). The agent gets the full
`browser_*` toolset (navigate, click, type, snapshot, tabs, console) and
drives a **real browser on your screen** — no relay, no in-app WebView
like the phone needed. The **Browser tab** is the control panel: live
target list via the shell's `/cdp/json` proxy, refreshed every 3s.

- Disable with `MOCH_BROWSER=0`; port with `MOCH_BROWSER_PORT`
  (default 9222, +10 fallbacks). The browser is Moch's own profile —
  your normal Chrome is never touched.

## Design

Mocheme, tokens verbatim from the app's `src/lib/theme.ts`: navy-hue
near-black surfaces, sprout orange reserved for primary actions (dark ink
on it), the user bubble in Mochi's cream with visor-navy ink, assistant
messages flat on the background, 12% soft washes, radii 16/24+8/32/999.
Markdown renders with marked + DOMPurify; inline code on `accentSoft`
(the theme's documented `code_inline` contract).

## Run

```sh
cd desktop
(cd ui && npm install)        # once
npm run build:ui              # vite build → web-ui/
./src-tauri/target/debug/moch-desktop   # or: npm run dev / npm run build
```

First run shows the setup wizard (Set up Moch locally → provider key →
chat). Subsequent runs go straight in. Everything lives in
`runtime-home/` + `.setup.json`.

- `MOCH_SELFTEST=1` — autonomous round trip on every tab's RPCs,
  logged to `desktop/.dbg.log` (the verification channel).
- `MOCH_HERMES_HOME=…` — move the runtime home (e.g. point at
  `~/.hermes` to share the CLI's home — by default Moch keeps its own,
  like the phone).
- `MOCH_ATTACH=1` — escape hatch: attach an external serve on 9119.
- `MOCH_HERMES_PYTHON=…` — python for the runtime (default: the
  installed hermes' venv python).

## Rounds (feature per feature)

| Round | Shipped |
| --- | --- |
| 1 | Mocheme design system (tokens from theme.ts), chat rebuilt to the phone's identity |
| 2 | Markdown rendering (GFM + sanitize; code cards, accentSoft inline code) |
| 3 | Real session rows (server order BUG-012, profile fan-out BUG-112, relative time, counts) |
| 4 | Bots tab to phone parity (builder agent; confirm:true delete, seed checklist) + SIGTERM runtime cleanup |
| 5 | Crew (columns, correct complete {task_id,summary}, run ledger), Automations (run-now, edit + #108 guard), Skills (searchable catalog), Models (key forms, reasoning efforts), Run (latency ping) |
| 5b | WS reconnect supervisor (backoff + silent-drop detection) |
| 6 | Per-bot chat switcher (session.create {profile, follow_profile_config}) |
| 7 | Markdown in task bodies/prompts; dead-CSS prune |
| build | Release profile verified live: 4.4MB binary + moch-desktop.sh launcher |
| 8 | Real branding — Moch logo, favicon, Mochi expressions (greeting/deep-thinking/idea/error/offline/listening/celebration), turn-reactive mochi |
| audit | 5-agent read-only audit, then the fix wave: approvals/clarify cards (onRequest — previously every agent ask was auto-declined), stop/interrupt, error blocks (no more celebrating failures), per-session busy gating, transcript-correct resume, chat wire fixes (tool_id, duration_s, reasoning.delta, {kind,text}), honest shell (real chat search + live status bell, Automations nav restored, honest nav labels, fake dots/avatar/popover/mode-cards made real or removed), truthful right panel (mock Laravel task + fake feed/files/integrations deleted), model switching (phone-exact config.set), tab hardening (cold-start retries, timer cleanup, shared automation session, 3s ping cap), shell hardening (SIGTERM via ctrlc termination, process group + graceful SIGTERM→SIGKILL, token redacted from logs + config, Host check, traversal guard, single-instance flock, handshake fast-fail), markdown links open safely + https images render, 111 lines dead CSS pruned |
| audit 2 | 8-agent adversarial re-hunt (max effort), then fix wave 2: persistent WS client (reconnect no longer stacks dials/loses replay), tab-independent ask overlay (approvals answerable from ANY tab), batch-clarify `{answers}` (was silently cancel-all), request.cancel handling (no immortal cards), sudo/secret cards, reconnect resync + session.reclaimed, session.close after model picks (was leaking an agent per click), mountLoad keyed to socket-openness (cold tabs no longer die), cron envelope success flag, Skills timeout state, Wizard boot fallback + busy guards, stderr filtered + token log scrubbed 0600, XDG single-instance lock, Origin check on POSTs, **Agent Browser tab** (real Chromium via CDP) |

## Bundles (built)

```
desktop/src-tauri/target/release/bundle/
  deb/Moch_0.2.0_amd64.deb        2.37 MiB  ← the lightweight installable
  appimage/Moch_0.2.0_amd64.AppImage  97.9 MiB
```

The UI is EMBEDDED in the binary (verified: app selftests green with
web-ui/ deleted from disk). Remaining repo dependency: the python
runtime (runtime.py + the hermes fork) — future packaging round.

## Known limits

- Voice/media not wired (protocol exists; UI later).
- Batched multi-question clarifies render as one card with per-question
  inputs; `session.title` / `session.usage` / `cron.changed` events are
  not yet surfaced (manual refresh for now).
- Runtime discovery: `MOCH_DESKTOP_DIR` env → exe-relative
  `src-tauri/target/*` scan → compile-time path. Installed deb/AppImage
  bundles still need the repo checkout (or `MOCH_DESKTOP_DIR`) for
  `runtime.py` + the hermes fork — packaging the runtime is a future
  round.
- Wayland rendering under sandboxed launches shows the WebKitGTK scale
  bug — launch from a normal terminal (x11 default) for clean rendering.
