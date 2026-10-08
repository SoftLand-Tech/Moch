# Interactive Linux terminal — your own live Ubuntu prompt

Branch `feat/linux-terminal` · worktree `worktrees/linux-terminal`

## Why this feature

The agent already runs guest commands (`exec_in_guest`, one-shot), but the
*human* had no shell: no way to poke around Moch Linux yourself — check a
file, `apt install` something, watch a log, kill a stuck job. This adds a
**Terminal** drawer entry: a live Ubuntu prompt, yours to drive, dieable at
every level.

## What it does

A persistent interactive `bash -i` inside the same Moch Linux guest the
agent uses (Ubuntu 24.04 under proot). Type commands on the phone keyboard,
output streams live. Touch key row covers what the soft keyboard lacks
(Tab, ↑/↓ history, Ctrl+C, Ctrl+D, Esc). Toolbar: clear screen, kill session.
Works warm (reattach + 64KB replay) and cold (fresh login shell). The
session survives leaving the tab; swipe-killing the app ends it; Settings →
Reset wipes the whole guest.

## How it works

```
Terminal screen ──poll drain(120ms)──▶ HermesBridge ──▶ moch/terminal.py
  RN scrollback + input                   │ 7 promise methods    │ openpty + Popen(build_guest_launch(["/bin/bash","-i"]))
  (xterm WebView later)                   │ (no event emitter)   │ reader thread banks byte chunks (base64 at the edge)
                                          ▼                      ▼
                              src/lib/terminal.ts ◀── poll ── proot guest bash (OWN proc, not the agent's)
                              (node-safe core: b64, ANSI strip, controller)
```

- **Python** `app/python-runtime/moch/terminal.py` (new): the PTY engine —
  `openpty`, persistent shell with its own session (`setsid`, so `\x03`
  reaches the foreground group), `TERM=xterm-256color`, `TIOCSWINSZ` resize,
  `start/write/drain/replay/resize/kill/is_running/probe`. Same M8 launch
  shape as everything else (linker64 + native-lib `PROOT_LOADER`) — nothing
  new executable. The agent's path is untouched (separate proot proc).
- **Kotlin** `HermesBridgeModule.kt`: `linuxTerm{Probe,Start,Write,Drain,
  Replay,Resize,Kill}` — promise-only, threaded like `linuxExec`. JS polls
  `drain()`; no native event emitter (v1).
- **TS** `src/lib/hermesRuntime.ts` (wrappers) + `src/lib/terminal.ts`
  (new, node-safe like `shareIn.ts`: dependency-free base64 encode, raw
  base64 bank, `TerminalController` state machine, sentinel composer
  field machine, injectable fakes).
- **UI** `app/(tabs)/terminal.tsx`: `ScreenShell` screen, gated on
  `linuxStatus().bootstrapped` + `linuxTermProbe()` (pty/shell),
  **xterm.js 5.5.0 in a local-asset WebView** (single self-contained
  `app/android/app/src/main/assets/term/index.html`, MIT licenses
  intact) + hidden sentinel-typing input + two-row extra-keys pad +
  composer. Drawer entry in `ScreenShell.tsx` nav (`terminal-outline`),
  route in `go()`, tab in `(tabs)/_layout.tsx`.
- **Tests**: `scripts/test-terminal.ts` (wired as `test:terminal`
  in `npm run verify`: raw byte-flow, bank cap, sentinel field machine)
  + `app/python-runtime/tests/test_terminal.py`
  (5 tests: probe round-trip, echo, Ctrl+C interrupt, replay/resize,
  kill/restart).

## Renderer (v1.5 — xterm.js)

- The screen renders through a real VT emulator: raw PTY bytes flow
  `drain → onChunk → injectJavaScript → window.__tq → atob →
  xterm.write` (per-frame flush). Erases, colors, cursor addressing and
  5000-line scrollback are real — BUG-097 (erase-blind Text renderer)
  and BUG-094 (whole-buffer re-renders) classes are gone by design.
- The WebView is `pointerEvents: none`: taps bubble to the RN wrapper
  (tap-to-focus re-raises the IME), and typing stays on the proven
  hidden sentinel input (BUG-095) — bytes go bridge-direct, display
  comes back through the drain. KeyRow writes bypass the WebView.
- Fit: WebView `onLayout` → throttled `__fit` → xterm resize ack →
  `TIOCSWINSIZE` with real cols/rows (v1 was fixed 80×24).
- Poll: 50ms while the screen is mounted (`TERM_DRAIN_FAST_MS`), the
  agent exec path stays 120ms.
- Known tradeoff: touch-scrolling the xterm viewport is disabled by
  `pointerEvents: none` (v1.5); scrollback browsing needs a future
  affordance (scroll-mode keys or selectable WebView).

## Deliberately unchanged

- Single session (no tabs/splits). Raw replay bank capped at ~196KB for
  WebView reloads/renderer-death. Typing never renders local text (PTY
  echo is the display — no double echo). `vim` smoke is still the
  acceptance test for the renderer.

## In-app test procedure (needs a dev APK — native bridge changed)

```
cd app/android && ./gradlew assembleRelease && adb install -r app/build/outputs/apk/release/app-release.apk
```

1. **Open** — drawer → Terminal → prompt appears (`root@localhost`).
2. **Echo** — `uname -a && head -2 /etc/os-release` → Ubuntu lines stream in.
3. **Streaming** — `apt update` (or `ping -c 20 8.8.8.8`) → lines arrive live.
4. **Interrupt** — `sleep 30` → `^C` → prompt returns immediately.
5. **History** — `↑` recalls the last command.
6. **Reattach** — leave to Chat, come back → output intact, session alive.
7. **Kill** — skull → confirm → `[session ended]` → Retry boots fresh.
8. **Agent isolation** — ask the agent to run a command in chat while the
   terminal is open → neither transcript corrupts the other.
9. **Reset** — Settings → Reset Linux → terminal reports dead (guest gone).

## Rollback

Additive: delete `terminal.tsx`, the drawer entry + route + tab line, the
seven bridge methods, `terminal.py`, `terminal.ts`, and the two test files.
The guest and the agent path are untouched.
