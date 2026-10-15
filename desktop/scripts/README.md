# Moch desktop — acceptance harness

Scripts that stand between “it compiles” and “it works” for the Tauri shell +
exported app UI. Everything here is safe to run **while the user’s desktop
instance is live**: nothing kills, restarts, or reconfigures it, and nothing
writes into `desktop/runtime-home/`.

> Session note (2026-10-15): the real `expo export` via `build-app-web.sh`
> ran successfully (exit 0, `desktop/app-web/` populated, ~10 MB) and the
> window-capture tool inventory below was verified live. The remaining
> runtime verifications (bash -n, serve+curl, shot.mjs, verify-desktop.sh
> runs) were blocked: the agent executor lost ALL process spawning
> (`UNKNOWN: unknown error, write` on bash/glob/workflows) immediately after
> the export finished and never recovered. Re-run the invocations below.

| file | purpose |
|------|---------|
| `build-app-web.sh` | Export the REAL phone app (Expo SDK 57, RN-web) to `desktop/app-web`, the directory the shell embeds. Refuses to run concurrently with another build (flock), fails loudly on non-zero exit, prints the output file list + total size. |
| `serve-app-web.sh` | Serve `desktop/app-web` on a loopback port **with a synthesized `/moch-config.json`** whose `wsUrl` is `ws://127.0.0.1:<handshake-port>/api/ws` (fallback 9118) and whose `token` is re-read from `desktop/runtime-home/.moch-gateway.json` on every request. SPA fallback, correct content types, `Cache-Control: no-store`. Lets the REAL app UI be exercised against the LIVE gateway with no second shell. |
| `shot.mjs` | Node CDP driver: launches `/usr/bin/chromium --headless=new` with `--remote-debugging-port=<free port>`, renders the URL at each width via `Emulation.setDeviceMetricsOverride`, waits for load + network quiet + settle, captures `Page.captureScreenshot`, and collects console errors/warnings, `Log.entryAdded`, `Network.loadingFailed`, uncaught exceptions, `document.body.innerText`, and a horizontal-overflow check. Writes `<out>/<W>x<H>.png` + `<out>/report.json`. Kills chromium (whole process group) on every exit path; hard timeout. |
| `verify-desktop.sh` | The acceptance gate: instance detection via the single-instance flock (graceful — never disturbs a live instance), UI readiness, `shot.mjs` at 4 widths, PNG plausibility + pixel non-uniformity, cold-start + peak RSS (shell mode), optional `--chat` CDP chat turn. Writes `desktop/.tmp/verify/report.md` with PASS/FAIL per check plus raw evidence. |

## Exact invocations

```bash
WT=/home/mamoun/ai/learning/Moch/worktrees/desktop-tauri

# 1. export the phone app to desktop/app-web (~2–4 min)
$WT/desktop/scripts/build-app-web.sh

# 2. serve the export against the LIVE gateway (default port 8099)
$WT/desktop/scripts/serve-app-web.sh 8099
#   → http://127.0.0.1:8099/   (Ctrl-C stops it cleanly)

# 3. screenshots + diagnostics at the four widths
node $WT/desktop/scripts/shot.mjs \
  --url http://127.0.0.1:8099/ \
  --out $WT/desktop/.tmp/shots \
  --widths 1024x768,1280x840,1440x900,1920x1080 \
  --settle 2500

# 4. the full acceptance gate (served mode — always safe)
$WT/desktop/scripts/verify-desktop.sh --mode served

#    with a CDP-driven chat turn (types into the composer, Enter, waits
#    for streamed assistant text):
$WT/desktop/scripts/verify-desktop.sh --mode served --chat

#    shell mode: launches the actual Tauri binary, parses
#    “moch: static server on <port>” from stderr, measures cold start +
#    peak RSS, then kills ONLY the instance it launched. SKIPS with a
#    clear message if the user’s instance holds the flock:
$WT/desktop/scripts/verify-desktop.sh --mode shell
```

Exit codes: `verify-desktop.sh` exits 0 only when every check passed;
`shot.mjs` exits 2 when the page rendered nothing or logged uncaught errors,
3 on chromium/CDP failures, 124 on hard timeout.

## Results directory

`desktop/.tmp/` (gitignored scratch):

- `.tmp/verify/report.md` — the acceptance report (PASS/FAIL table + evidence)
- `.tmp/verify/raw/` — shot.mjs log, shot evaluation, body text, config as
  served, serve log, shell stderr, peak RSS sample
- `.tmp/shots/` (or `.tmp/verify/shots/`) — `<W>x<H>.png` + `report.json`
  with every console error, warning, exception, network failure, overflow
  measurement and the full `document.body.innerText` per width

## Screenshotting the REAL WebKitGTK window on this machine

Investigated live on this box (2026-10-15). Tool inventory:

| tool | status |
|------|--------|
| `grim` | **INSTALLED** (`/usr/bin/grim`) — Wayland output capture |
| `import` (ImageMagick) | **INSTALLED** (`/usr/bin/import`) — speaks X11 |
| `hyprctl` | **INSTALLED** (`/usr/bin/hyprctl`) — Hyprland IPC |
| `hyprshot` | missing |
| `wayshot` | missing |
| `scrot` | missing |
| `xwd` | missing |
| `spectacle` | missing |
| `gnome-screenshot` | missing |
| `flameshot` | missing |
| `maim` | missing |

Session context observed: `XDG_SESSION_TYPE=wayland`,
`WAYLAND_DISPLAY=wayland-1`, `DISPLAY=:0` (XWayland is up).

The app forces `GDK_BACKEND=x11` when unset (`desktop/src-tauri/src/main.rs`),
so the real Moch window is an **XWayland** window — X11 tools can see it, and
Hyprland still tracks it (with `xwayland: true` and its XWayland geometry).

Candidate commands, in order of preference:

```bash
# A) Hyprland geometry + grim full-output capture + crop (Wayland path).
#    hyprctl gives the window's at/size; grim captures the whole output, so
#    crop afterwards (captures everything on that output for an instant —
#    fine for an acceptance harness, all local).
geo="$(hyprctl -j clients | python3 -c '
import json,sys
for c in json.load(sys.stdin):
    if c.get("class","").lower().startswith("moch") and c.get("mapped"):
        x,y = c["at"]; w,h = c["size"]; print(f"{x},{y} {w}x{h}"); break
')"
read -r xy wh <<<"$geo"
grim -t png -o "$(hyprctl -j monitors | python3 -c '
import json,sys
for m in json.load(sys.stdin):
    if m.get("focused"): print(m["name"]); break
')" /tmp/moch-full.png
import /tmp/moch-full.png -crop "$wh+$xy" desktop/.tmp/window-capture.png

# B) Pure-X11 path against the XWayland window (GDK_BACKEND=x11 window):
#    needs the X window id. xdotool/xwininfo are NOT installed, so derive
#    the id via hyprctl's XWayland metadata or list roots with ImageMagick:
DISPLAY=:0 import -window root -dump /tmp/root.x 2>/dev/null || true
#    …or, if a window id is known: DISPLAY=:0 import -window <id> out.png
```

**Status: the tool inventory above is verified; the end-to-end capture
command could not be live-confirmed during this session — the agent
executor lost the ability to spawn ANY process (bash/ripgrep/workflows all
failed with `UNKNOWN: unknown error, write`) right after the export
finished, and never recovered. Run candidate A once to confirm; it needs
nothing that is missing.**
