# Moch Desktop (Tauri 2) — local-only PC build

**v0.2 — complete rebuild.** No React Native, no relay, no phone. A fresh,
small web UI running in a Tauri window, talking to a **local hermes** on
this PC through the Moch app's own TypeScript protocol stack, imported
verbatim from `../app/src/protocol/` (fork changes included).

```
┌ Tauri shell (Rust) ────────────────────────────────────────────────┐
│ 1. SUPERVISOR: spawns the hermes fork (app/hermes-src/cli.py serve │
│    --host 127.0.0.1 --port 9118, token minted by us). Falls back   │
│    to attaching the machine serve on 9119 (systemd, token from     │
│    ~/.config/hermes-serve.env). Child is killed when the app ends. │
│ 2. LOCAL SERVER: serves the built UI + /moch-config.json on        │
│    127.0.0.1:<port> — a loopback origin hermes' WS guard accepts.  │
│ 3. WINDOW on that origin.                                           │
│    ┌ UI (Vite+React, desktop/ui) ────────────────────────────────┐ │
│    │ JsonRpcGatewayClient (app's protocol stack, unchanged)      │ │
│    │ ws://127.0.0.1:<port>/api/ws?token=…                        │ │
│    │ sessions · streaming chat · thinking · tool rows · replay   │ │
│    └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

## Run

```sh
cd desktop
npm run install:ui   # once
npm run dev          # or: npm run build  → AppImage/deb
./src-tauri/target/debug/moch-desktop   # after a build
```

The window badge shows the active mode: **fork** (spawned from
`app/hermes-src`, your changes) or **attached** (the machine-level serve
on 9119). Sessions/providers come from the same `~/.hermes` as the CLI.

Notes:

- Linux uses the X11 backend by default (`GDK_BACKEND=x11`) to dodge the
  WebKitGTK fractional-scale crop bug on Wayland; override with
  `GDK_BACKEND=wayland` to test.
- `MOCH_SELFTEST=1 ./src-tauri/target/debug/moch-desktop` runs an
  autonomous round trip (connect → ping → session → prompt → reply) and
  logs every step to `desktop/.dbg.log`.
- `MOCH_HERMES_PYTHON` overrides the python used for the fork
  (default: the installed hermes' venv python).
- `npm run export:web` / `web/` from v0.1 (Expo web export wrapper) are
  gone — that approach is retired.

## RPC surface used (same shapes as `app/scripts/test-live.ts`)

`session.create {title,cols,source:'mobile'}` · `session.list {limit}` ·
`session.resume {session_id,cols}` · `session.events.since
{session_id,last_seen}` (history replay) · `prompt.submit
{session_id,text}` · `gateway.ping` — events: `message.*`, `thinking.delta`,
`tool.*`, `session.title`, `status.update`.

## Known limits (next steps)

- Markdown rendering is plain text so far; code blocks not styled.
- No automations/skills/models screens yet — chat + sessions + history
  first, the rest incrementally.
- Attachments/voice not wired (protocol pieces exist; UI work).
- Fork serve under a *sandboxed* harness dies on read-only `~/.hermes`
  (Errno 30) — run from a normal terminal; attach mode covers the rest.
