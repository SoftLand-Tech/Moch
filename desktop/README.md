# Moch Desktop

**Hermes agents on your desktop, with a local control plane.**

Moch Desktop is an experimental **Hermes-only** workspace. It uses the vendored Hermes tree in `app/hermes-src` and the fleet runtime in `app/python-runtime`, rebuilt for the desktop. It does not integrate OpenCode.

- **Bot-first UI** — the Fleet roster is the home; bots, crew board, inbox, browser, terminal and automations are the primary surfaces. The layout is a four-zone desktop shell (icon rail / context column / focus / stage pane) in the same Mocheme palette as the mobile app.
- **Local control plane** — the app spawns or adopts its own Hermes gateway on `127.0.0.1`, with a dedicated Hermes home under `~/.local/share/moch-desktop/hermes` and workspace at `~/Moch`. No pairing, Moch relay or remote gateway is required, and no Moch account is needed.
- **Warm reconnects** — the gateway is adopted between window re-opens through a state-file handshake, and the webview reconnects to the loopback socket.

## Local does not mean offline

The Hermes control plane and workspace stay on the desktop. Hosted model providers, model catalogs, downloads, package installation, web browsing, web search, remote MCP servers and terminal commands may still use the internet. Providers may require their own accounts, API keys or payment. Connect a compatible local model endpoint for on-device inference.

## Layout

```
desktop/
  runtime/            the Python side: moch_desktop launcher + venv
    moch_desktop/     boot chain (see server.py docstring)
    requirements.txt  exact dependency set (the phone's, desktop-pinned)
    setup.sh          one-time venv setup
  src-tauri/          the Rust shell (Tauri 2)
    src/gateway.rs    spawn/adopt/restart the Hermes gateway process
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

The agent browser is a dedicated headless Chromium owned by the app (`browser.rs`), driven over CDP by both the user (the Browser pane renders a live screencast and forwards input) and Hermes (the agent's browser tools are armed at the same endpoint via the `moch.desktop.browser_cdp` RPC). One browser, two drivers — the user can grab the wheel at any moment.

This local CDP connection is unrelated to the retired remote WebSocket relay used by stable Moch v1.0.0. Web pages and browser tools can still access the network. See [`../SECURITY.md`](../SECURITY.md) for the security boundary.

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
| `~/.local/share/moch-desktop/hermes` | the Hermes home (bots/profiles, sessions, memory, cron) |
| `~/.local/share/moch-desktop/desktop-runtime.json` | gateway port + token (0600) |
| `~/Moch` | the workspace (chats run here; the terminal opens here) |
| `~/.local/share/moch-desktop/chromium-profile` | the agent browser's persistent profile |

`MOCH_DESKTOP_STATE_DIR` relocates all of it (dev sandboxes, tests).

## Test gates

- `desktop/ui`: `npm run build` (TypeScript strict + Vite)
- `desktop/src-tauri`: `cargo check`
- `desktop/runtime`: `.venv/bin/python -m moch_desktop --status`
- end-to-end: `tauri dev` → the window boots, the runtime is adopted or spawned, chat answers, the terminal spawns a shell in `~/Moch`, and the browser pane streams the agent Chromium.
