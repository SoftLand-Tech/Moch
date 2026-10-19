# Moch Desktop

**Your own hermes agents, on your desktop — fully local, no relay, no cloud.**

Moch Desktop is the Tauri shell around the same hermes runtime the phone ships
(the vendored fork in `app/hermes-src` + the Moch fleet runtime in
`app/python-runtime`), rebuilt for the desktop:

- **Bot-first UI** — the Fleet roster is the home; bots, crew board, inbox,
  browser, terminal and automations are the primary surfaces. The layout is a
  four-zone desktop shell (icon rail / context column / focus / stage pane) in
  the same Mocheme palette as the mobile app.
- **Fully local** — the app spawns its own gateway on `127.0.0.1` (a dedicated
  hermes home under `~/.local/share/moch-desktop/hermes`, workspace at `~/Moch`),
  connects over the same v7 JSON-RPC the phone speaks, and nothing ever leaves
  the machine. No pairing, no relay, no links.
- **Blazing fast** — the gateway is adopted between window re-opens (state-file
  handshake), the webview connects to a warm loopback socket, and the first
  paint is a native-colored splash.

## Layout

```
desktop/
  runtime/            the Python side: moch_desktop launcher + venv
    moch_desktop/     boot chain (see server.py docstring)
    requirements.txt  exact dependency set (the phone's, desktop-pinned)
    setup.sh          one-time venv setup
  src-tauri/          the Rust shell (Tauri 2)
    src/gateway.rs    spawn/adopt/restart the hermes gateway process
    src/pty.rs        real PTY host for the terminal
    src/browser.rs    dedicated Chromium (CDP) for the agent browser
  ui/                 the webview app (Vite + React + nanostores)
    src/protocol/     v7 JSON-RPC client (copied from the phone app — browser-safe)
    src/lib/          gateway connection, chat state, fleet, cdp, pty client…
    src/views/        Chat, Fleet, Crew, Inbox, Browser, Terminal, Automations,
                      Skills, Connectors, Settings
    dev-bridge.ts     plain-browser preview plugin (user-testing track)
```

## The browser

The agent browser is a dedicated headless Chromium owned by the app
(`browser.rs`), driven over CDP by BOTH the user (the Browser pane renders a
live screencast and forwards input) and the agent (hermes' browser tools are
armed at the same endpoint via the `moch.desktop.browser_cdp` RPC). One
browser, two drivers — the user can grab the wheel at any moment.

## Run it (development)

```sh
cd desktop/runtime && ./setup.sh          # once: create the venv
cd desktop/src-tauri
npx tauri dev                             # from the tauri config dir
```

The UI alone (browser preview against a running gateway — PTY/mock-limited):

```sh
cd desktop/ui && npm install && npm run dev
MOCH_DESKTOP_STATE_DIR=<state dir> …      # dev-bridge reads the runtime state
```

## State

| Path | What |
|---|---|
| `~/.local/share/moch-desktop/hermes` | the hermes home (bots/profiles, sessions, memory, cron) |
| `~/.local/share/moch-desktop/desktop-runtime.json` | gateway port + token (0600) |
| `~/Moch` | the workspace (chats run here; the terminal opens here) |
| `~/.local/share/moch-desktop/chromium-profile` | the agent browser's persistent profile |

`MOCH_DESKTOP_STATE_DIR` relocates all of it (dev sandboxes, tests).

## Test gates

- `desktop/ui`: `npm run build` (tsc strict + vite)
- `desktop/src-tauri`: `cargo check`
- `desktop/runtime`: `.venv/bin/python -m moch_desktop --status`
- end-to-end: `tauri dev` → the window boots, the runtime is adopted or
  spawned, chat answers, the terminal spawns a shell in `~/Moch`, the browser
  pane streams the agent Chromium.
