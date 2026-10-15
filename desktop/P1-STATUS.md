# P1 status — 2026-10-15 21:15 (branch `desktop-tauri`)

## What P1 is

The make-or-break proof: the **real Moch app UI** (react-native-web export of
`app/`) running inside the Tauri shell, connected to the shell's **own local
gateway** — instead of the frozen hand-written fork in `desktop/ui/`.

## Done — code (P1)

| File | Change |
| --- | --- |
| `app/src/lib/desktopLocal.ts` | NEW shared module. Reads the shell's `GET /moch-config.json`, adopts the supervised loopback gateway as the remembered computer named "This computer". No-op on the phone (not `web`) and on the plain web build (404). Never hijacks a *remote* computer the user paired. `isLoopbackHost` / `dialInfoFromWsUrl` / `desktopShell` atom exported for later use. |
| `app/app/_layout.tsx` | Boot IIFE now `stored = await loadSavedConfig()` then `saved = (await seedDesktopLocalConnection(stored)) ?? stored`, before cache loaders and the first dial. Import added. |
| `desktop/src-tauri/tauri.conf.json` | `build.frontendDist`: `../web-ui` → `../app-web` (the shell now embeds the shared app, not the fork). |
| `desktop/package.json` | `build:app-web` script (expo export → `desktop/app-web`); `dev` / `build` / `selftest` now build the app UI instead of the frozen fork. |
| `desktop/.gitignore` | `app-web/` ignored. |
| `desktop/src-tauri/src/lib.rs` | (a) NEW `ui_dir()` — disk fallback prefers `app-web/`, keeps `web-ui/` as legacy. (b) GET handler rewritten: SPA fallback to `index.html` **only for routes** (extensionless); a missing ASSET now 404s instead of being served as HTML under a `.js`/`.css`/`.ttf` content type; content type now comes from the file actually served, not the request key. |

Why the bridge works without touching the shell: `buildDialUrl` (`app/src/lib/dialTransport.ts:46`)
builds `ws://<host>/api/ws?token=…` from `ConnConfig.host`, and the shell's
handshake host is exactly `127.0.0.1:<port>`. The gateway's Host/Origin guard
accepts that origin (`hermes_cli/web_server.py` loopback set), which is why the
shell serves the UI from loopback in the first place.

## Done — artifacts

- `desktop/app-web/` — clean export of the SHARED app (145 files, 9.9 MB),
  produced by run `bash-651` **after** the fork's race; `app-web/index.html`
  references `_expo/static/js/web/entry-2c829b761e571c80684e99256090fc8c.js`,
  the exact bundle that run wrote. The export was made **after** the
  `desktopLocal.ts` + `_layout.tsx` edits, so the bridge is inside the bundle.
- Docs from the team: `desktop/ARCHITECTURE.md` (decision record, entry point),
  `desktop/PARITY-BACKLOG.md` (16-row P3 backlog), `desktop/ui/FROZEN.md`,
  `desktop/README.md` (Status section correcting 5 false claims),
  `desktop/DESKTOP-SHELL-SPEC.md` (P2 spec, 737 lines),
  `desktop/.tmp/recon/tauri-feasibility.md`.
- Harness: `desktop/scripts/{build-app-web.sh,serve-app-web.sh,shot.mjs,verify-desktop.sh,README.md}`.

## NOT verified — environment outage

From **19:31** every process-spawning path fails with
`UNKNOWN: unknown error, write`: `bash` (even `echo`/`df`), `glob`/ripgrep,
background jobs, workflow workers. All three teammates hit the same wall
independently. File read/write/edit tools still work.

**Diagnosis (2026-10-15 22:55, read from `/proc` — reads outside the workspace
do work):**

- **It is not a full disk.** `/` and `/home` are the same btrfs device
  (`/dev/mapper/root`, subvols `@` and `@home`), and workspace writes succeed —
  so that filesystem has space.
- `/tmp` is a **tmpfs** (`usrquota` on the mount line), i.e. RAM-backed;
  `/dev/shm` too.
- RAM is tight: `MemTotal 7.97 GB`, **`MemAvailable 0.70 GB`**, `MemFree 0.25 GB`;
  swap `24.7 GB` total / `16.3 GB` free. `Shmem` (all tmpfs together) is only
  **146 MB**, so `/tmp` is not full right now.
- PSI memory: `some avg10=2.24`, `full avg10=2.23` — modest pressure now.

Resources are therefore currently *usable* while the executor stays broken. The
most likely explanation is a **wedged harness process** — its spawn/job layer
failed once and never recovered — not a resource shortage.

Recovery, in order:

1. **Restart the DSH session/agent process behind the GUI, then resume.** Every
   file on disk survives; this document is the resume point.
2. If it recurs, free RAM first: `pgrep -af chromium` and kill the headless
   probes (never the Moch-owned one), `rm -rf /tmp/.org.chromium.* /tmp/moch-probe-profile`
   — `/tmp` is tmpfs and only ~0.7 GB is available.
3. Or just run the four gate commands below from a normal terminal; they need
   no harness.

Manual review done while blocked (both changes re-read line by line, in place of
the `cargo build`/`tsc` I could not run): the `lib.rs` GET rewrite is
type-correct (`Option<(&'static str, Vec<u8>)>`, `Cow::into_owned`, borrows of
`key`/`rel`), `ui_dir()` sits correctly beside `desktop_dir()`, and
`desktopLocal.ts` uses `fetch('/moch-config.json')` — the shell matches that
path **exactly** (`lib.rs:557`), so no query string may be added.

Because of this, P1 is **implemented but not executed**: no `cargo build`, no
run, no screenshots, no typecheck. `lib.rs` changes are unproven at compile time.

## Finish the gate (once the environment works)

```sh
cd /home/mamoun/ai/learning/Moch/worktrees/desktop-tauri/desktop

# 1. FREE THE LOCK — the running old instance holds it (flock, not a signal):
flock -n "$XDG_RUNTIME_DIR/moch-desktop.lock" -c 'echo free' || echo "still held — quit the running Moch"

# 2. Rebuild the shell with the new embedded UI (app-web already exists):
cd src-tauri && cargo build 2>&1 | tail -20 && cd ..

# 3. Gate, served mode first (no second gateway, does not disturb anything):
./scripts/verify-desktop.sh --mode served          # chrome renders app-web + /moch-config.json
./scripts/verify-desktop.sh --mode served --chat   # drives a real prompt turn

# 4. Gate, shell mode (needs the lock free): cold start, window, screenshots
./scripts/verify-desktop.sh --mode shell
```

Expected pass signal in served mode: the DOM shows the **chat surface**, not the
pairing screen — `desktopLocal.ts` adopting `127.0.0.1:<port>` from
`/moch-config.json` and `app/app/index.tsx` redirecting to `/(tabs)/chat`
because `connConfig` is set. `runtime-home/auth.json` already holds provider
credentials (`zai`, `copilot`) and `.env` has `GLM_API_KEY`, so a turn can
stream.

That prediction rests on a chain verified by reading the code (no runner needed):

1. `desktopLocal.ts` → `saveConfig(cfg)` → `validateConfig` (`gateway.ts:139`)
   → `normalizeHost('127.0.0.1:9118')` returns it unchanged
   (`transportGate.ts:12-27`, regex allows dots/digits/colon).
2. The dial is plaintext to a private host → `needsPlaintextConfirm` is false
   (`transportGate.ts:62-64`, `isPrivateHost:38-54` matches loopback), so no
   confirmation dialog stands in the way.
3. `buildDialUrl` (`dialTransport.ts:46`) → `ws://127.0.0.1:9118/api/ws?token=…`,
   the exact endpoint `lib.rs` hands the UI in `cfg.wsUrl`.
4. `connConfig` is set before the router mounts → `app/index.tsx:29-36`
   redirects to `/(tabs)/chat`.
5. The gateway's Host/Origin guard accepts a `127.0.0.1:<port>` origin
   (`hermes_cli/web_server.py` loopback set) — which is why the shell serves the
   UI from loopback rather than `tauri://localhost`.

## Watch items at the gate

1. `lib.rs` compiles (`ui_dir()` + the `served: Option<(&'static str, Vec<u8>)>` rewrite).
2. The shell's `/moch-config.json` token and the live handshake token match.
3. On a hard reload of a deep route, `index.html` must be served as `text/html`
   (the new content-type path).
4. Window capture on this box: `hyprctl -j clients` geometry → `grim` → `import -crop`
   (`grim`, `import`, `hyprctl` are installed; the app forces `GDK_BACKEND=x11`).

## D1 gate results — 2026-10-16

The gate ran on this machine with the uncommitted P1 code compiled and three shell additions (inspector seam, runtime respawn watchdog, parking_lot/LazyLock per repo rules). Evidence lives in `desktop/.tmp/verify/d1/`.

Unit.

- `cargo build` green (33-58 s incremental).
- `npm run typecheck` green in `app/`.
- `bash -n` green on all four desktop shell scripts.

Shell gate numbers (program baseline, recorded per plan).

- Cold start launch to UI answering: **11154 ms** (budget 20000 ms).
- Peak RSS of the shell process: **162312 kB / 158 MiB** (budget 1.2 GB). The poller tracks the shell pid only; the gateway and agent browser are separate processes.

Live lanes.

- Lane 1 base vs head: base (pre-D1 release build, frozen fork UI) shows the fork's "Chat Bots Crew Automations Skills Models Browser Runtime" screen; head shows the real app chat surface. `lane1-base-forkui.png`, `lane1-head-chat.png`, `lane5-restart.png`.
- Lane 5 restart: after a full stop/start the app lands on the chat surface with the gateway reconnected. History rows untested (typing instrument, below).
- Lane 6 recovery: **fixed and verified.** Killing the runtime child used to strand the shell with no gateway. The new watchdog respawns it (stable per-home token `tYrIg52h` across boots keeps the UI's saved auth valid); a turn completed 7.4 s after the kill on the respawned gateway.
- Lane 8 inspector: `MOCH_DEV=1` exposes `WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223`; the port accepts and the boot log confirms, but plain HTTP gets an empty reply. WebKit speaks its own inspector protocol, so DOM reads still need a client; OCR remains the reader of record.

Blocked by instruments, not by app code.

- Lane 4 / 9 (in-window typing): no click injector on this box. `wtype` now dies with `wl_display error 2` under the harness, `xdotool`/`ydotool` are absent, and the Hyprland Lua `send_key_state` requires a `mods` shape that could not be satisfied blind.
- Lane 7 (four widths): `shot.mjs` chromium still SIGTRAPs at spawn (10 of 11 boots), and the Hyprland `window.resize` shim takes unreliable delta semantics (three attempts, three behaviors). Two instruments to fix outside the harness.
- Served gate: core checks pass (handshake, TCP, app-web, ui-http, moch-config with token match); the shot/chat-turn lanes stay instrument-blocked as above.

Harness notes for D13.

- In shell mode the `gateway-tcp` check runs BEFORE the gate boots the shell, so it fails by order, not by fact. Reorder or re-check after launch.
- The peak-RSS poller should walk the process tree (shell + runtime.py + chromium), not just the shell pid.
