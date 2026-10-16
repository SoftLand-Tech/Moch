# Moch Desktop — the complete feature map

Every mobile feature, on the desktop, in its desktop form — plus what the
desktop adds. Verification evidence from the live build sessions (Oct 16,
2026) included. Branch: `desktop/app` (worktree `worktrees/desktop`).

## Architecture (the ask, honored literally)

| Ask | How |
|---|---|
| The Moch backend (the forked hermes) | `desktop/runtime/moch_desktop` boots the SAME vendored fork (`app/hermes-src`, hermes-agent 0.21.3 + the Moch patches) + the SAME fleet runtime (`app/python-runtime/moch`) the phone ships — headless on loopback, with desktop adaptations (no Android shims; subprocesses stay stock; `GATEWAY_MULTIPLEX_PROFILES`; BUG-120 token-leak neutralization; `moch.desktop.*` RPCs) |
| Fully local, no remote/link | Zero pairing UI, zero relay code paths; the app spawns/adopts its own gateway on 127.0.0.1 (dedicated home; first-run `--import-from ~/.hermes` brings your provider keys over — nothing leaves the machine) |
| Blazing fast | 6.3MB stripped release binary; **window visible in ~121ms** against a warm gateway (state-file adopt handshake); the webview connects to a live loopback socket; gateway cold boot ≈10–30s once (skills seed), instant after |
| Bot-first UI, not the mobile UI | Four-zone desktop shell (icon rail / context column / focus / stage pane) in the same Mocheme palette — designed from the competitor canon (dots.bot, Grok Bot, Muse; see `research/moch-desktop-ui-research.md`) |
| Browser that suits the desktop | A dedicated headless Chromium owned by the app, driven over CDP by BOTH you (live screencast pane + input forwarding + tabs) and the agents (hermes' browser tools armed at the same endpoint) — one browser, two drivers, takeover any time |

## Mobile feature → desktop form

| Mobile | Desktop | Verified |
|---|---|---|
| Streaming chat + thinking blocks | Same v7 event stream; collapsible Thinking with elapsed seconds; markdown on completion; copy/listen | ✅ live model round-trip, reasoning+text streaming |
| Multi-session + attention badges | Sidebar with pin/archive/delete/rename, per-row busy dots, live↔stored id bridging | ✅ sessions list/resume/pin |
| Approvals / clarify / sudo / secret cards | Shared InteractiveCard with the exact v7 shapes (choice/answers/value); inline in chat AND a unified Inbox | ✅ approved a `touch /tmp/...` — file created, turn continued |
| Bots (M9 fleet) | Fleet roster home: wizard with checklist + live slug, SOUL editor, provider mirror, freeze, two-tap delete, in-character bot chat, per-bot Recent runs | ✅ bot created, replied in character, runs visible |
| Crew board | Real 4-column desktop kanban + run ledger; tasks dispatch to FleetWorker | ✅ task → dispatched → done → ledger |
| Automations (cron) | Plain-language schedule editor, run-now/pause/edit/delete, cron-knock notifications | ✅ `every 2h` job created with next-run |
| Agent browser | The shared Chromium + CDP screencast pane (above) | ✅ agent-browsing seen live in the pane; links in chat open in it |
| Terminal (Moch Linux) | Real host PTYs (Rust portable-pty) × N xterm sessions; Stage dock; workspace cwd | ✅ cargo test + live typing→echo through the full stack |
| Skills / slash commands | Gateway-driven catalog; `/` popup; `/model` opens the picker | ✅ popup lists live catalog |
| Connectors | Providers (key connect/disconnect) + MCP servers (add/status/test/remove) | ✅ live provider list rendered |
| Voice out (Listen) | TTS via the gateway through the shell proxy | ✅ plays valid Ogg, zero errors |
| Voice in (mic STT) | MediaRecorder → gateway transcribe → composer (never auto-sends) | ⏳ needs a real mic (user test) |
| Media attachments | Drag-drop + clipboard paste → proxied upload → attach; agent reads them | ✅ dropped file's codeword read back |
| Share-in ("Ask Moch") | Desktop-native: drag-drop anywhere on the composer + Ctrl+V paste | ✅ |
| Mochi mascot | mochi-svgs at her moments: greeting / deep-thinking / connecting | ✅ renders |
| i18n EN/AR + RTL | 85-key catalog (57 verbatim from the phone), Settings picker, full RTL flip | ✅ live Arabic + dir=rtl |
| Knocks (notifications) | Tauri notifications: inbox transitions + cron outcome watcher | ✅ code paths (permission prompts on first use) |
| MEDIA: file delivery | Inline images/audio/video + file cards with reveal/copy-path | ✅ agent-made PNG decoded in-page |
| Multi-computer pairing / relay | **Deliberately absent** — the desktop IS the machine (per the ask) | — |
| OTA updates | N/A — AppImage distribution | — |
| Camera/QR | N/A — nothing to pair | — |

## Desktop-only additions

Stage pane (dockable Terminal/Browser beside chat) · Cmd+K command palette ·
Ctrl+1–9 view keys · one shared agent browser · links open in it · honest
net-status + auto-reconnect with jittered backoff · error boundary · release
AppImage (98MB) + tiny binary.

## Evidence artifacts

- `.devtest/DESKTOP-SESSION-NOTES.md` — running state + verification log
- `desktop/TEST-PLAN.md` — the full click-everything campaign
- Commits on `desktop/app`: 272e110 → 1ee8456 → 963e53f → e5c4183 → 3e454c1 → 30ad10a → 74de988 (+ this round)
