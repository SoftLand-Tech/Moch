# Moch Desktop (Tauri 2) — local-only PC build

**Your own hermes agent, on your PC — through Moch, not through hermes.**
The desktop twin of the phone's embedded mode: the app runs its OWN agent
runtime (the fork, in a Moch-owned home) and a fresh web UI talks to it
over loopback with the app's TypeScript protocol stack, imported verbatim.

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
│  │ Tabs: Chat · Bots · Crew · Automations · Skills · Models · Run│ │
│  └───────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

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

- Voice/media not wired (protocol exists; UI later). Automations
  run-now/edit not yet in the tab (list/pause/resume/add are).
- Wayland rendering under sandboxed launches shows the WebKitGTK scale
  bug — launch from a normal terminal (x11 default) for clean rendering.
