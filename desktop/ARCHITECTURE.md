# Moch Desktop Architecture — one core, two presentations

> **Status: ACCEPTED — decision record, 2026-10-15** (branch `desktop-tauri`).
> This is the authoritative document for the desktop effort. It supersedes the
> step-1 plan in [FEATURE-DESKTOP-TAURI.md](../FEATURE-DESKTOP-TAURI.md) and
> corrects the claims in [desktop/README.md](README.md) (see its Status section).
> Companion docs: [desktop/PARITY-BACKLOG.md](PARITY-BACKLOG.md) (the parity
> debt, per capability) and [desktop/ui/FROZEN.md](ui/FROZEN.md) (the legacy
> fork notice).

All file paths are relative to the worktree root. Line numbers were read from
this branch on 2026-10-15; `desktop/src-tauri/src/lib.rs` is under active
modification, so its line numbers may drift — the route/function names are the
stable reference.

---

## 1. The decision

**The desktop UI depends on the phone app's real code: the same screens and the
same `app/src/lib` logic, rendered in the Tauri webview via react-native-web.**
The desktop is not a second app; it is a second presentation of one app.

The desktop owns ONLY:

- **(a) the native shell** — Tauri: menus, tray, notifications, window state,
  global hotkey, file dialogs, updater;
- **(b) a desktop presentation layer** — nav rail, collapsible/resizable panes,
  command palette, accelerators, dense tables;
- **(c) the local runtime + packaging** — `desktop/runtime.py` and the
  installer story (P5).

### The hard rule

**No business/protocol logic in the desktop tree.** New behaviour goes into
`app/src/lib` (or `app/src/components`) and BOTH platforms consume it.
Desktop-only components must import the same state/logic modules rather than
reimplement them. If a change only makes sense on the phone, it still lives in
the shared layer behind a platform seam; if it only makes sense on the desktop,
only its *presentation* lives in the desktop tree.

### The frozen fork

`desktop/ui/` — the hand-written parallel UI — is **frozen**: migrated screen
by screen into the shared core, then deleted once the last screen is matched.
See [desktop/ui/FROZEN.md](ui/FROZEN.md). No new features, no cosmetic work on
the dying fork.

---

## 2. Why this decision was made

Two independent audits (2026-10-15) converged on the same conclusion: the fork
cannot catch up, and it was never a desktop UI to begin with.

### 2.1 The fork is a second app, not a client

- `desktop/ui/` is a **hand-written parallel re-implementation**: ~5.8k lines
  (audit: 5,755; `wc -l` over `desktop/ui/src/*.{tsx,ts,css}` on 2026-10-15:
  5,768), 8 tabs (`desktop/ui/src/tabs/`: Chat, Bots, Crew, Automations,
  Skills, Models, Browser, Run).
- It shares **exactly two modules** with the phone app:
  `app/src/protocol/json-rpc-gateway` (`desktop/ui/src/App.tsx:9`) and the
  mascot states (`desktop/ui/src/MochiInteractive.tsx:8`). Every other
  reference to phone files in the fork is a comment.
- It speaks ~32 protocol methods where the phone uses ~65 (audit figures; a
  grep of quoted method-name literals on 2026-10-15 finds 26 vs 47 — same
  ratio, same conclusion).
- Missing entirely from the fork: terminal/PTY, MCP connectors + OAuth, all
  media send/view, voice STT/TTS, session management (delete/search/status),
  the Settings screen, bot SOUL editor + provider mirror, slash palette /
  steer / queue / retry, OS notifications, i18n/RTL (per-capability detail and
  owners: [PARITY-BACKLOG.md](PARITY-BACKLOG.md)).
- The phone is still evolving — branch `ui/chat-revamp` carries a bots-first
  redesign — so a parallel implementation would be chasing a moving target
  forever.

### 2.2 The fork was never shaped like a desktop app

- **Zero `@media` queries** in 834 lines of CSS (`desktop/ui/src/styles.css`,
  grep count 0 on 2026-10-15) and zero in the built bundle (audit).
- Fixed 236px sidebar (`desktop/ui/src/styles.css:130`) + fixed 330px right
  panel (`desktop/ui/src/styles.css:723`); no pane resize or collapse; content
  is clipped below 566px with no scrollbar (audit).
- No menu bar, no command palette, no drag-drop, no context menus, no
  window-state persistence, no tray, no `aria-*` attributes, no
  `:focus-visible` styles (audit).
- The only window-level keyboard handler in the whole UI is Escape closing the
  notifications popover (`desktop/ui/src/App.tsx:251-259`); the composer inputs
  handle bare Enter-to-send (`desktop/ui/src/tabs/Chat.tsx:707,881`,
  `desktop/ui/src/Asks.tsx:199,288,325`) — there are no accelerators.
- The composer floats over the transcript with a fake 90px bottom pad
  (`desktop/ui/src/styles.css:563`, `.floating-bottom-composer` at :693).
- Worst offender: the model badge is a `<div>` with `cursor:pointer` and no
  `onClick` (`desktop/ui/src/tabs/Chat.tsx:723-726`; the code itself admits
  "Display-only badge" at `desktop/ui/src/tabs/Chat.tsx:364`) — the most
  prominent composer control is dead.

### 2.3 The evidence channel was stale

The only screenshots (`desktop/docs-shots/*.png`) are 500x757 — phone-shaped —
captured by `desktop/.shots.cjs` at `--window-size=480,900`
(`desktop/.shots.cjs:32`), driving a `.tab` selector that no longer exists in
the UI (`desktop/.shots.cjs:51`). They were last touched at commit `2900c4d`,
which is **16 `desktop/ui` commits behind HEAD** (`git rev-list
2900c4d..HEAD --count -- desktop/ui` = 16, 2026-10-15). The real window is
1280x840 (`desktop/src-tauri/src/lib.rs:731`, `.inner_size(1280.0, 840.0)`).
Shipping them as documentation of the desktop app stops now (P0).

### 2.4 Packaging and verification gaps

- The deb/AppImage contain ONLY the binary — no `runtime.py`, no hermes fork,
  no Python (the AppDir holds `usr/bin/moch-desktop` plus desktop metadata;
  zero `.py` files).
- Both embed machine-baked absolute paths (e.g. the venv fallback
  `/home/mamoun/.hermes/hermes-agent/venv/bin/python`,
  `desktop/src-tauri/src/lib.rs` python discovery).
- Port 9118 is fixed (`desktop/src-tauri/src/lib.rs:23`) and the readiness
  probe is an unauthenticated "something accepts on this port" TCP connect
  (`wait_port`, `desktop/src-tauri/src/lib.rs:166-175`).
- The agent browser is fire-and-forget (spawned by `desktop/runtime.py`, no
  health gate).
- **Zero tests exist under `desktop/`** (audit).
- The UI build runs `vite build` with no typecheck, and the fork's tsconfig
  include path points at a non-existent directory
  (`desktop/ui/tsconfig.json` includes `../../../app/src/protocol`, which
  resolves to `worktrees/app/src/protocol` — the app actually lives at
  `<worktree>/app`).
- The shipped deb/AppImage embed a stale UI bundle: the AppImage binary
  contains `index-Bxg3r1Gs.js` (strings) while today's build is
  `desktop/web-ui/assets/index-DgiOoQ5x.js`.

### 2.5 What the audits found worth keeping (do not disparage)

- **The Rust shell** (`desktop/src-tauri/src/lib.rs`): loopback static server,
  single-instance flock, process-group SIGTERM→SIGKILL, token scrubbing in
  logs (`line_carries_token`), CDP proxy (`GET /cdp/json`), file-based
  handshake with fast-fail. These mechanisms carry over to the new
  architecture unchanged in role.
- **`desktop/runtime.py`**: runs the app's OWN local gateway — `MOCH_FLEET=1`
  so bots/crew install (`runtime.py:43`), `HERMES_DESKTOP=1` cron ticker
  (`runtime.py:44`) — and spawns a Moch-owned Chromium with CDP
  (`--remote-debugging-port`, fresh `--user-data-dir`, `BROWSER_CDP_URL`
  published at `runtime.py:96-115`) so the agent gets real browser tools.
- **Real parity already achieved** on: chat streaming, markdown,
  approvals/clarify/sudo/secret, bots, crew, automations, models (audit).
- The **right-panel live tool-step inspector** (`desktop/ui/src/RightPanel.tsx`)
  is a genuine desktop-only win — it is ported forward as a desktop
  presentation concept, not deleted with the fork.

### 2.6 Why the shared-core path is feasible (verified)

- `react-native-web@^0.21.2` and `react-dom@19.2.3` are already dependencies
  (`app/package.json:44`, `:38`); `npm run web` exists (`app/package.json:64`);
  `app/app.json` has a web block (`:41`).
- Verified 2026-10-15 (recorded in the decision brief): `npx expo export
  --platform web` exits 0, and headless Chromium renders the real app's
  pairing screen.

---

## 3. Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│ L4 · NATIVE BRIDGE — desktop/src-tauri (Rust) + desktop/runtime.py      │
│     Tauri IPC surface: menus · tray · notifications · window state ·    │
│     global hotkey · file dialogs · updater                             │
│     Shell services: loopback static server · runtime supervision       │
│     (flock, SIGTERM→SIGKILL, token-scrubbed logs, handshake fast-fail, │
│     CDP proxy) · local gateway + Moch-owned agent Chromium              │
├─────────────────────────────────────────────────────────────────────────┤
│ L3 · DESKTOP SHELL — desktop-only presentation, inside the webview     │
│     nav rail · collapsible/resizable/persisted panes · Ctrl+K palette  │
│     accelerators · dense tables · context menus · focus rings + ARIA   │
│     MAY: render, layout, keyboard. MUST NOT: protocol or business      │
│     logic — it imports L1/L2 modules for all state and behaviour       │
├─────────────────────────────────────────────────────────────────────────┤
│ L2 · PRESENTATION PRIMITIVES                                           │
│     react-native (phone) / react-native-web (desktop webview)          │
│     The SAME screens (app/app/**) and shared components                │
│     (app/src/components/**); per-platform primitives isolated in       │
│     .web / .native variants at the edge                               │
├─────────────────────────────────────────────────────────────────────────┤
│ L1 · SHARED CORE — app/src/lib/** + app/src/protocol/**                │
│     gateway client · chat engine · session/fleet/media/voice/slash/    │
│     terminal state · theme · i18n                                      │
│     The ONLY home for behaviour. Both presentations consume it.        │
└─────────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly downward: L3 → L2/L1, L2 → L1. Nothing in
L1/L2 may import from the desktop tree.

## 4. Shared vs desktop-only inventory

| Concern | Owner (single home) | Phone | Desktop |
| --- | --- | --- | --- |
| JSON-RPC gateway client, transports, reconnect | `app/src/protocol/**`, `app/src/lib/gateway.ts` | RN | react-native-web (the fork's one real import: `desktop/ui/src/App.tsx:9`) |
| Chat engine: send/stream, events, approvals, steer/queue/retry | `app/src/lib/chat.ts`, `app/src/lib/sendQueue.ts` | RN | same module |
| Session list/state/running status | `app/src/lib/sessionList.ts`, `sessionRunning.ts`, `sessionRowMeta.ts` | RN | same modules |
| Fleet (bots/crew), automations | `app/src/lib/fleet.ts`, `automationsState.ts` | RN | same modules |
| Slash/command registry + routing | `app/src/lib/slash.ts` | RN | same module |
| Media upload/cache/bubbles | `app/src/lib/mediaSend.ts`, `mediaCache.ts`, `media.ts`, `app/src/components/media/**` | RN | same modules (fetch/blob seams on web) |
| Voice STT/TTS | `app/src/lib/voice.ts`, `voiceLevels.ts`, `VoiceRecStrip.tsx` | RN | same modules (MediaRecorder seam on web) |
| Terminal controller (byte flow) | `app/src/lib/terminal.ts` | RN | same module; xterm.js renderer on desktop |
| MCP connectors | `app/src/lib/mcpState.ts` | RN | same module |
| Model state/picker logic | `app/src/lib/modelState.ts` | RN | same module |
| Theme, i18n/RTL | `app/src/lib/theme.ts`, `strings.ts` | RN | same modules |
| Screens | `app/app/**` | RN | same screens in the webview |
| Mascot states | `app/src/components/mochi/mochiStates.gen` | RN | already shared today (`desktop/ui/src/MochiInteractive.tsx:8`) |
| Nav rail, panes, palette, accelerators, dense tables, tool-step inspector | desktop presentation layer (new, in the desktop tree) | — | desktop only, imports the shared modules |
| Native shell: menus/tray/notifications/window state/hotkey/dialogs/updater | `desktop/src-tauri` | — | desktop only |
| Local runtime, gateway supervision, agent Chromium, packaging | `desktop/runtime.py` + Tauri bundling | — | desktop only |

## 5. Frozen-legacy policy

1. `desktop/ui/` is frozen as of 2026-10-15. **No new features. No cosmetic
   work.** Fix only what blocks the migration itself.
2. Migration is screen by screen: mount the phone's real screen in the
   desktop shell, check off the matching rows in
   [PARITY-BACKLOG.md](PARITY-BACKLOG.md), then delete the fork's version of
   that screen.
3. When the last screen is matched, `desktop/ui/` is deleted.
4. Desktop-only concepts (the tool-step inspector, the nav rail, the local
   boot wizard's UX) are re-implemented in the desktop presentation layer
   against shared state — the fork's implementations inform the design but
   are not carried over as code.
5. What to do instead of touching the fork: put behaviour in
   `app/src/lib`/`app/src/components`, presentation in the desktop layer. See
   [desktop/ui/FROZEN.md](ui/FROZEN.md).

## 6. Roadmap (P0–P6)

- **P0** freeze the story: one architecture doc; supersede the step-1 doc;
  stop shipping the stale screenshot pack; no cosmetic work on the dying fork.
- **P1** the make-or-break proof: run the REAL app UI inside the Tauri window
  against the local runtime (local boot -> connect -> stream a reply -> answer
  an approval -> reconnect), plus screenshots at 1024/1280/1440/1920. The one
  genuine unknown is react-native-web performance/fidelity in WebKitGTK.
- **P2** desktop shell: nav rail; collapsible/resizable/persisted panes;
  Ctrl+K palette; accelerators (Ctrl+1..9, Ctrl+B/J, Ctrl+Enter send,
  Shift+Enter newline); native menu; window state; focus rings + ARIA;
  density pass (tables); context menus.
- **P3** parity debt, in this order (the desktop's hero use-case is running
  your own agent on the PC): 1 terminal/PTY, 2 connectors/MCP+OAuth, 3 media
  (drag-drop attach, viewer, upload), 4 session management, 5
  settings/theme/language/diagnostics/export, 6 slash palette +
  steer/queue/retry, 7 voice (MediaRecorder -> same STT endpoint), 8 bot SOUL
  editor + provider mirror, 9 OS notifications for approvals, 10 i18n/RTL.
  Each lands in the SHARED layer.
- **P4** native depth: tray + close-to-tray, global quick-ask hotkey,
  multi-window, drag-drop-to-chat, auto-updater.
- **P5** real installer: bundle runtime.py + app/python-runtime + the hermes
  fork as Tauri resources/sidecars; ship or bootstrap a pinned Python instead
  of the hardcoded venv; move HERMES_HOME/logs/profile to XDG dirs; dynamic
  port + authenticated readiness; rebuild and smoke-test on a clean machine.
- **P6** verification as a gate: multi-resolution screenshots and a desktop
  smoke suite; no "done" claim without a run.

P3 is tracked per capability — phone owner, evidence, desktop status, shared
landing spot, desktop-native shape, acceptance check — in
[PARITY-BACKLOG.md](PARITY-BACKLOG.md).

## 7. How to verify

Claims in this doc, re-checkable in minutes:

| Claim | Check | Expected |
| --- | --- | --- |
| Fork size / tab count | `wc -l desktop/ui/src/*.{tsx,ts,css}`; `ls desktop/ui/src/tabs/` | ~5.8k lines; 8 tabs |
| Only two shared modules | `grep -rn "app/src" desktop/ui/src` (imports only, not comments) | `App.tsx:9`, `MochiInteractive.tsx:8` |
| No responsive CSS | `grep -c '@media' desktop/ui/src/styles.css` | 0 |
| Fixed panes | `desktop/ui/src/styles.css:130` (236px), `:723` (330px) | fixed widths |
| Dead model badge | `desktop/ui/src/tabs/Chat.tsx:723-726` | `<div>`, no `onClick` |
| Stale screenshots | `file desktop/docs-shots/*.png`; `git rev-list 2900c4d..HEAD --count -- desktop/ui` | 500x757; 16 behind |
| Real window size | `desktop/src-tauri/src/lib.rs` (`.inner_size(1280.0, 840.0)`) | 1280x840 |
| Shipped bundle is stale | `strings` the AppImage binary vs `ls desktop/web-ui/assets/` | `index-Bxg3r1Gs.js` vs `index-DgiOoQ5x.js` |
| Token served in config | `GET /moch-config.json` handler in `desktop/src-tauri/src/lib.rs` | serves `cfg` verbatim, incl. live token |
| Web path is real | `cd app && npx expo export --platform web` | exit 0 (verified 2026-10-15) |

The P1 gate (not yet run — it is the make-or-break proof): boot the local
runtime and open the REAL app UI in the Tauri window; verify local boot ->
connect -> stream a reply -> answer an approval -> reconnect; capture
screenshots at 1024/1280/1440/1920 widths. P6 makes this shape permanent: no
"done" claim without a run.

## 8. Document map

- [desktop/ARCHITECTURE.md](ARCHITECTURE.md) — this doc; the decision, layers,
  roadmap. Entry point.
- [desktop/PARITY-BACKLOG.md](PARITY-BACKLOG.md) — the P3 parity debt, one
  row per capability, with phone owners and acceptance checks.
- [desktop/ui/FROZEN.md](ui/FROZEN.md) — the legacy fork notice.
- [desktop/README.md](README.md) — how to run the current (frozen) build,
  plus the 2026-10-15 status corrections.
- [FEATURE-DESKTOP-TAURI.md](../FEATURE-DESKTOP-TAURI.md) — the superseded
  step-1 plan, kept for history.
