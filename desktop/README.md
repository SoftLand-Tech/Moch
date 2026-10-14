# Moch Desktop (Tauri 2)

**Step 1 — the proof.** A lightweight desktop shell around the Moch app you
already have: this folder is a Tauri 2 window that loads the **Expo web
export** of `../app` and connects in **linked mode** — the same
`wss → relay → moch-link → hermes serve` path the phone uses. No changes to
the app itself; the exported bundle is the frontend.

```
┌ Tauri 2 shell (Rust, system webview — webkit2gtk/WebView2/WKWebView) ┐
│  window (420×860, phone layout) · CSP allows wss: to the relay       │
│  ┌ Expo web export (react-native-web) — Moch UI + TS protocol stack ┐│
│  │  linked mode: wss://api.moch.softland.tech (v7 JSON-RPC)         ││
│  └──────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

Why this works without touching the app: the TS protocol stack
(`app/src/protocol/`) is transport-agnostic, state lives in nanostores, the
UI already runs on `react-native-web`, and `gateway.ts` already degrades
gracefully when `expo-secure-store` is unavailable (web).

## Prerequisites

- Rust (`rustup`) and Node (SDK 57's documented runtime: Node 22.13.x —
  newer works for the export).
- Linux build deps: `webkit2gtk-4.1`, `gtk3`, `libsoup3` (on Arch:
  `pacman -S webkit2gtk-4.1`). macOS/Windows need no extra webview deps.
- `app/node_modules` — the sibling app checkout must have run `npm install`
  (or symlink one in, as this worktree does).

## Run it

```sh
cd desktop
npm install                     # @tauri-apps/cli only
npm run export:web              # expo export --platform web → desktop/web
npx tauri dev                   # window + webview debug build
npm run build                   # bundle installers (AppImage/deb on Linux)
```

Notes:

- `desktop/web/` is build output — gitignored. Re-run `export:web` after
  app changes (no dev-server hot reload in this step; that's fine for a
  proof and can come later via `devUrl` + `expo start --web`).
- If `npm install` hits `EROFS` in a sandbox, keep the cache local:
  `npm_config_cache="$PWD/.npm-cache" npm install`.

## Roadmap

- **Step 2 — local mode:** the shell supervises `hermes serve` on
  127.0.0.1 (spawn, health-poll, restart), session token in the OS
  keyring, and the app dials `ws://127.0.0.1` exactly like a linked
  computer. Desktop *is* the machine hermes runs on — no relay needed.
- **Step 3 — desktop polish:** tray + close-to-tray, quick-ask global
  hotkey, native notifications for knocks (replacing expo-notifications),
  drag-and-drop media into the composer, multi-pane layout
  (sidebar + chat side-by-side), Tauri updater instead of expo-updates.

## What is platform-gated on desktop (and why it's fine)

| Mobile feature | Desktop status |
| --- | --- |
| `expo-secure-store` | falls back to app storage (web path already handles it); OS keyring lands in step 2 |
| `expo-notifications` / knocks | no-op on web today; native notifications in step 3 |
| camera / QR scan | pairing via the manual entry path; camera surfaces can be hidden |
| keyboard-controller / haptics | no IME problem on desktop — inert |
| embedded runtime (Chaquopy/proot) | deliberately absent — hermes runs natively on desktop |
| `expo-updates` (OTA) | replaced by Tauri's own updater in step 3 |
