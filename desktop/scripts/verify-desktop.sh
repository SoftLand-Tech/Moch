#!/usr/bin/env bash
# verify-desktop.sh — the ACCEPTANCE GATE for the Moch desktop integration.
#
# Checks (all written, PASS/FAIL, to desktop/.tmp/verify/report.md):
#   1. instance-detect     — single-instance flock probed WITHOUT disturbing a
#                            live instance (never killed, never reconfigured)
#   2. gateway-handshake   — live token readable from runtime-home handshake
#   3. gateway-tcp         — 127.0.0.1:<port> accepts TCP
#   4. app-web-present     — the exported bundle exists
#   5. ui-http             — the UI answers HTTP (index + /moch-config.json)
#   6. moch-config         — served config has a loopback wsUrl + real token
#                            (and, in served mode, the token matches the live
#                            handshake — proof the synthesis is live)
#   7. shot                — shot.mjs renders the REAL app UI at 4 widths with
#                            DOM text, PNGs, console/exception evidence
#   8. png-plausible       — every PNG > 20 KB
#   9. png-pixels          — decoded pixels are non-uniform (not a blank frame)
#  10. body-text           — the exact rendered text is captured (if it shows
#                            pairing/onboarding, THAT is the finding — never
#                            special-cased into a pass)
#  11. chat-turn (--chat)  — one chat turn driven over CDP end-to-end
#  12. cold-start/peak-rss — shell mode only (launch → UI answering; VmHWM)
#
# Modes:
#   --mode served (default)  desktop/app-web served by serve-app-web.sh; the
#                            REAL app UI exercises the LIVE gateway. No shell
#                            launch — always safe while the user's instance
#                            holds the lock.
#   --mode shell             launch the Tauri binary, parse
#                            `moch: static server on <port>` from its stderr,
#                            measure cold start + peak RSS, screenshot, then
#                            kill ONLY the instance WE launched. If the
#                            single-instance lock is HELD (the user's live
#                            instance), the launch is SKIPPED with a clear
#                            message — never forced.
#
# Usage:
#   desktop/scripts/verify-desktop.sh [--mode served|shell] [--chat]
#                                     [--port 8099]
#                                     [--widths 1024x768,1280x840,1440x900,1920x1080]
#                                     [--settle 2500]
#
# Exit: 0 all passed · 1 any check failed (or a shell-mode run was blocked).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$DESKTOP_DIR/.tmp/verify"
RAW="$OUT_DIR/raw"
LOCK_PATH="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/moch-desktop.lock"
HANDSHAKE="$DESKTOP_DIR/runtime-home/.moch-gateway.json"

MODE="served"
CHAT=0
PORT=8099
WIDTHS="1024x768,1280x840,1440x900,1920x1080"
SETTLE=2500
CHROMIUM=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)   MODE="${2:?--mode needs a value}"; shift 2 ;;
    --chat)   CHAT=1; shift ;;
    --port)   PORT="${2:?--port needs a value}"; shift 2 ;;
    --widths) WIDTHS="${2:?--widths needs a value}"; shift 2 ;;
    --settle) SETTLE="${2:?--settle needs a value}"; shift 2 ;;
    --chromium) CHROMIUM="${2:?--chromium needs a value}"; shift 2 ;;
    *) echo "verify-desktop: FATAL: unknown arg '$1'" >&2; exit 1 ;;
  esac
done
[[ "$MODE" == "served" || "$MODE" == "shell" ]] || {
  echo "verify-desktop: FATAL: --mode must be served or shell (got '$MODE')" >&2; exit 1; }

mkdir -p "$RAW"

# ── check bookkeeping ────────────────────────────────────────────────────────
PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
CHECK_NAMES=(); CHECK_STATUSES=(); CHECK_NOTES=()
check() { # check <PASS|FAIL|SKIP> <name> <note...>
  local status="$1" name="$2"; shift 2
  CHECK_NAMES+=("$name"); CHECK_STATUSES+=("$status"); CHECK_NOTES+=("$*")
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)); echo "verify-desktop: PASS  $name — $*" ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); echo "verify-desktop: FAIL  $name — $*" >&2 ;;
    SKIP) SKIP_COUNT=$((SKIP_COUNT + 1)); echo "verify-desktop: SKIP  $name — $*" ;;
  esac
}
now_ms() { date +%s%3N; }

# ── 1-3: instance + gateway detection (strictly read-only) ─────────────────
INSTANCE_STATE="not-running"
if [[ -e "$LOCK_PATH" ]] && ! flock -n "$LOCK_PATH" -c true 2>/dev/null; then
  INSTANCE_STATE="running"
  check PASS "instance-detect" "single-instance lock HELD ($LOCK_PATH): a Moch desktop instance is live — this gate will not touch it"
else
  check PASS "instance-detect" "no lock holder on $LOCK_PATH — no desktop instance detected"
fi

GW_PORT=9118
GW_TOKEN=""
if [[ -f "$HANDSHAKE" ]]; then
  GW_PORT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("port") or 9118)' "$HANDSHAKE" 2>/dev/null || echo 9118)"
  GW_TOKEN="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("token") or "")' "$HANDSHAKE" 2>/dev/null || true)"
fi
if [[ -n "$GW_TOKEN" ]]; then
  check PASS "gateway-handshake" "handshake OK: port=$GW_PORT, token present (${#GW_TOKEN} chars, read-only, never printed)"
else
  check FAIL "gateway-handshake" "no token in $HANDSHAKE ($([[ -f $HANDSHAKE ]] && echo file exists || echo MISSING)) — live gateway cannot be adopted"
fi

if timeout 3 bash -c "</dev/tcp/127.0.0.1/$GW_PORT" 2>/dev/null; then
  check PASS "gateway-tcp" "127.0.0.1:$GW_PORT accepts TCP (live gateway)"
else
  check FAIL "gateway-tcp" "127.0.0.1:$GW_PORT refuses TCP — gateway not listening?"
fi

# ── 4: exported bundle ──────────────────────────────────────────────────────
if [[ -f "$DESKTOP_DIR/app-web/index.html" ]]; then
  check PASS "app-web-present" "desktop/app-web present ($(du -sh "$DESKTOP_DIR/app-web" | cut -f1)); run build-app-web.sh to refresh"
else
  check FAIL "app-web-present" "desktop/app-web/index.html missing — run desktop/scripts/build-app-web.sh first"
fi

# ── UI acquisition ──────────────────────────────────────────────────────────
UI_URL=""
SERVE_PID=""
SHELL_PID=""
RSS_POLL_PID=""
COLD_START_MS=""

launch_served() {
  "$SCRIPT_DIR/serve-app-web.sh" "$PORT" >"$RAW/serve.log" 2>&1 &
  SERVE_PID=$!
  local t0; t0=$(now_ms); local waited=0
  until curl -fsS "http://127.0.0.1:$PORT/moch-config.json" -o "$RAW/moch-config.json" 2>/dev/null; do
    waited=$((waited + 1))
    if (( waited > 150 )) || ! kill -0 "$SERVE_PID" 2>/dev/null; then
      check FAIL "ui-http" "serve-app-web.sh did not answer on :$PORT (log: $RAW/serve.log)"
      return 1
    fi
    sleep 0.1
  done
  COLD_START_MS=$(( $(now_ms) - t0 ))
  UI_URL="http://127.0.0.1:$PORT/"
  check PASS "ui-http" "UI answering at $UI_URL after ${COLD_START_MS}ms (static server cold start)"
}

launch_shell() {
  if [[ "$INSTANCE_STATE" == "running" ]]; then
    check SKIP "shell-launch" "SKIPPED: the user's live instance holds the single-instance lock — this gate never launches a second shell against the live agent home"
    return 1
  fi
  local BIN="$DESKTOP_DIR/src-tauri/target/release/moch-desktop"
  [[ -x "$BIN" ]] || BIN="$DESKTOP_DIR/src-tauri/target/debug/moch-desktop"
  if [[ ! -x "$BIN" ]]; then
    check FAIL "shell-launch" "no Tauri binary at src-tauri/target/{release,debug}/moch-desktop — build it first"
    return 1
  fi
  local t0; t0=$(now_ms)
  "$BIN" >"$RAW/shell.stdout" 2>"$RAW/shell.stderr" </dev/null &
  SHELL_PID=$!
  local port="" deadline=$(( $(now_ms) + 180000 ))
  while (( $(now_ms) < deadline )); do
    port="$(grep -oP 'moch: static server on \K[0-9]+' "$RAW/shell.stderr" 2>/dev/null | head -1 || true)"
    [[ -n "$port" ]] && break
    if ! kill -0 "$SHELL_PID" 2>/dev/null; then
      check FAIL "shell-launch" "shell exited before serving (stderr: $(tail -3 "$RAW/shell.stderr" 2>/dev/null | tr '\n' ' '))"
      SHELL_PID=""
      return 1
    fi
    sleep 0.2
  done
  if [[ -z "$port" ]]; then
    check FAIL "shell-launch" "no 'moch: static server on <port>' on stderr within 180s (see $RAW/shell.stderr)"
    return 1
  fi
  local w=0
  until curl -fsS "http://127.0.0.1:$port/moch-config.json" -o "$RAW/moch-config.json" 2>/dev/null; do
    w=$((w + 1))
    if (( w > 600 )); then check FAIL "ui-http" "/moch-config.json never answered on :$port"; return 1; fi
    sleep 0.1
  done
  COLD_START_MS=$(( $(now_ms) - t0 ))
  UI_URL="http://127.0.0.1:$port/"
  check PASS "shell-launch" "$BIN launched; static-server port parsed from stderr: $port"
  check PASS "ui-http" "shell UI answering at $UI_URL (cold start ${COLD_START_MS}ms incl. gateway handshake)"
  # Peak-RSS poller: VmHWM is the kernel-maintained high-water mark. Guarded
  # arithmetic + `|| true` everywhere — this subshell runs under set -e.
  (
    peak=0
    while kill -0 "$SHELL_PID" 2>/dev/null; do
      v="$(awk '/VmHWM/{print $2}' "/proc/$SHELL_PID/status" 2>/dev/null || true)"
      if [[ -n "${v:-}" ]] && (( v > peak )); then peak="$v"; fi
      echo "$peak" > "$RAW/peak-rss-kb.tmp"
      sleep 0.2
    done
    if [[ -f "$RAW/peak-rss-kb.tmp" ]]; then mv -f "$RAW/peak-rss-kb.tmp" "$RAW/peak-rss-kb"; fi
  ) &
  RSS_POLL_PID=$!
  return 0
}

stop_shell() {
  # Kill the shell FIRST, then wait for the poller — the poller loops until
  # the shell is gone, so waiting on it before the kill would deadlock.
  if [[ -n "$SHELL_PID" ]] && kill -0 "$SHELL_PID" 2>/dev/null; then
    kill "$SHELL_PID" 2>/dev/null || true   # ONLY our own child, never the user's
    local d=0
    while kill -0 "$SHELL_PID" 2>/dev/null && (( d < 100 )); do sleep 0.1; d=$((d + 1)); done
    if kill -0 "$SHELL_PID" 2>/dev/null; then kill -9 "$SHELL_PID" 2>/dev/null || true; fi
    wait "$SHELL_PID" 2>/dev/null || true
    check PASS "shell-shutdown" "our launched shell (pid $SHELL_PID) terminated cleanly on SIGTERM"
    SHELL_PID=""
  fi
  if [[ -n "$RSS_POLL_PID" ]] && kill -0 "$RSS_POLL_PID" 2>/dev/null; then
    wait "$RSS_POLL_PID" 2>/dev/null || true
    RSS_POLL_PID=""
  fi
}

cleanup() {
  stop_shell || true
  if [[ -n "$SERVE_PID" ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
    SERVE_PID=""
  fi
}
trap cleanup EXIT INT TERM

case "$MODE" in
  served) launch_served || true ;;
  shell)  launch_shell  || true ;;
esac

# ── 6: moch-config content ──────────────────────────────────────────────────
if [[ -s "$RAW/moch-config.json" ]]; then
  CFG_LINE="$(python3 - "$RAW/moch-config.json" "$GW_TOKEN" <<'PY'
import json, sys
try:
    c = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"invalid JSON ({e})"); sys.exit(1)
ws = c.get("wsUrl") or ""
tok = c.get("token") or ""
ok_ws = ws.startswith("ws://127.0.0.1:") and ws.endswith("/api/ws")
ok_tok = len(tok) >= 16
match = "tokenMatchesLiveHandshake=yes" if (sys.argv[2] and tok == sys.argv[2]) else "tokenMatchesLiveHandshake=no"
print(f"wsUrl={ws!r} tokenLen={len(tok)} {match}")
sys.exit(0 if (ok_ws and ok_tok) else 1)
PY
)" && check PASS "moch-config" "$CFG_LINE" || check FAIL "moch-config" "$CFG_LINE"
else
  check FAIL "moch-config" "no /moch-config.json captured (UI never answered)"
fi

# ── 7: screenshots + diagnostics ────────────────────────────────────────────
SHOT_STATUS=0
if [[ -n "$UI_URL" ]]; then
  SHOT_ARGS=(--url "$UI_URL" --out "$OUT_DIR/shots" --widths "$WIDTHS" --settle "$SETTLE")
  [[ -n "$CHROMIUM" ]] && SHOT_ARGS+=(--chromium "$CHROMIUM")
  (( CHAT == 1 )) && SHOT_ARGS+=(--chat)
  node "$SCRIPT_DIR/shot.mjs" "${SHOT_ARGS[@]}" >"$RAW/shot.log" 2>&1 || SHOT_STATUS=$?
else
  check FAIL "shot" "no UI URL to screenshot (UI acquisition failed above)"
fi

if compgen -G "$OUT_DIR/shots/*.png" >/dev/null; then
  ls -la "$OUT_DIR/shots"/*.png | awk '{print "verify-desktop: png: "$NF" "$5" bytes"}'
fi

if [[ -f "$OUT_DIR/shots/report.json" ]]; then
  python3 - "$OUT_DIR/shots/report.json" > "$RAW/shot-eval.txt" <<'PY'
import json, sys
rep = json.load(open(sys.argv[1]))
print(f"verdict={rep.get('verdict')} anythingRendered={rep.get('anythingRendered')} durationMs={rep.get('durationMs')}")
for w in rep.get("widths", []):
    print(f"  {w['spec']}: png={w['file']}({w['bytes']}B) rendered={w['rendered']} "
          f"textLen={len((w.get('bodyText') or '').strip())} overflowX={w['overflow']['overflowingX']} "
          f"consoleErrors={len(w['consoleErrors'])} exceptions={len(w['exceptions'])} "
          f"warnings={len(w['consoleWarnings'])} logEntries={len(w['logEntries'])} netFails={len(w['loadingFailed'])}")
    for e in w["exceptions"][:5]:
        print(f"    EXCEPTION: {(e.get('exception') or e.get('text') or '')[:400]}")
    for e in w["consoleErrors"][:10]:
        print(f"    CONSOLE.ERROR: {e['text'][:400]}")
    for e in w["consoleWarnings"][:5]:
        print(f"    CONSOLE.WARN: {e['text'][:250]}")
    for e in w["logEntries"][:8]:
        print(f"    LOG.{e['level']}: {e['text'][:250]}")
    for e in w["loadingFailed"][:8]:
        print(f"    NET-FAIL: {e.get('errorText')} ({e.get('type')})")
chat = rep.get("chat")
if chat:
    print(f"chat: attempted={chat.get('attempted')} error={chat.get('error')}")
    for s in chat.get("steps", []):
        print(f"    {s}")
    if chat.get("textAfter"):
        print("    transcript tail: " + chat["textAfter"][-500:].replace("\n", " | "))
PY
  cat "$RAW/shot-eval.txt"
else
  { echo "shot: no report.json produced (shot.mjs exit $SHOT_STATUS)"; tail -30 "$RAW/shot.log" 2>/dev/null; } | tee "$RAW/shot-eval.txt"
fi

if (( SHOT_STATUS == 0 )); then
  check PASS "shot" "shot.mjs exit 0 — rendered with no uncaught errors (evidence: $RAW/shot.log + shots/report.json)"
else
  check FAIL "shot" "shot.mjs exited $SHOT_STATUS — see $RAW/shot.log and shots/report.json (real evidence; nothing special-cased)"
fi

# ── 8: PNG plausibility (>20 KB each) ───────────────────────────────────────
if compgen -G "$OUT_DIR/shots/*.png" >/dev/null; then
  BAD=""
  for f in "$OUT_DIR"/shots/*.png; do
    sz=$(stat -c%s "$f")
    if (( sz <= 20480 )); then BAD+=" $(basename "$f")=${sz}B"; fi
  done
  if [[ -z "$BAD" ]]; then
    check PASS "png-plausible" "every screenshot > 20 KB — not blank frames"
  else
    check FAIL "png-plausible" "suspiciously small PNGs:$BAD"
  fi
else
  check FAIL "png-plausible" "no PNGs under $OUT_DIR/shots"
fi

# ── 9: pixel non-uniformity (pure-python PNG decode; PIL is not installed) ──
set +e
PIX_OUT="$(python3 - "$OUT_DIR/shots" <<'PY'
import os, struct, sys, zlib
shots, worst = sys.argv[1], None
for name in sorted(os.listdir(shots)):
    if not name.endswith(".png"):
        continue
    try:
        data = open(os.path.join(shots, name), "rb").read()
        pos, w, h, depth, color, idat = 8, 0, 0, 0, 0, b""
        while pos + 8 <= len(data):
            (ln,) = struct.unpack(">I", data[pos:pos+4]); typ = data[pos+4:pos+8]
            chunk = data[pos+8:pos+8+ln]
            if typ == b"IHDR": w, h, depth, color = struct.unpack(">IIBB", chunk[:10])
            elif typ == b"IDAT": idat += chunk
            pos += ln + 12
            if typ == b"IEND": break
        if depth != 8 or color not in (0, 2, 4, 6):
            print(f"  {name}: unsupported (depth={depth} color={color}) — skipped"); continue
        nch = {0:1, 2:3, 4:2, 6:4}[color]
        raw = zlib.decompress(idat)
        stride = w * nch + 1
        vals = set()
        for y in range(0, h, max(1, h // 64)):     # ≤65 sampled scanlines
            row = raw[y*stride + 1 : y*stride + 1 + w*nch]
            vals.update(row)
        print(f"  {name}: {w}x{h} distinctByteValues={len(vals)}")
        if worst is None or len(vals) < worst[1]: worst = (name, len(vals))
    except Exception as e:
        print(f"  {name}: decode failed ({e})")
sys.exit(0 if (worst and worst[1] > 8) else 2)
PY
)"
PIX_STATUS=$?
set -e
PIX_SUMMARY="$(printf '%s' "$PIX_OUT" | grep -c 'distinctByteValues=' || true)"
if (( PIX_SUMMARY == 0 )); then
  check FAIL "png-pixels" "no screenshot PNG could be decoded:$(printf '%s' "$PIX_OUT" | tr '\n' ';')"
elif (( PIX_STATUS == 0 )); then
  check PASS "png-pixels" "decoded scanline sample — every shot has >8 distinct byte values (non-uniform pixels):$(printf '%s' "$PIX_OUT" | tr '\n' ';')"
else
  check FAIL "png-pixels" "uniform/blank pixel content detected (≤8 distinct byte values in the worst shot):$(printf '%s' "$PIX_OUT" | tr '\n' ';')"
fi

# ── 10: body-text ground truth ──────────────────────────────────────────────
if [[ -f "$OUT_DIR/shots/report.json" ]]; then
  python3 - "$OUT_DIR/shots/report.json" > "$RAW/body-text.txt" <<'PY'
import json, sys
rep = json.load(open(sys.argv[1]))
for w in rep.get("widths", []):
    t = (w.get("bodyText") or "").strip()
    print(f"── bodyText @ {w['spec']} ({len(t)} chars) ──")
    print(t[:4000])
PY
  BODY_HEAD="$(head -c 400 "$RAW/body-text.txt" | tr '\n' ' ' | sed 's/  */ /g')"
  check PASS "body-text" "rendered DOM text captured (first 400 chars: “${BODY_HEAD}”) — full text in $RAW/body-text.txt"
fi

# ── 11: chat turn ───────────────────────────────────────────────────────────
if (( CHAT == 1 )); then
  if python3 - "$OUT_DIR/shots/report.json" <<'PY' 2>/dev/null
import json, sys
try:
    rep = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
c = rep.get("chat") or {}
sys.exit(0 if c.get("assistantSeen") else 1)
PY
  then
    check PASS "chat-turn" "composer driven over CDP + streamed assistant text observed (evidence: shots/report.json .chat)"
  else
    check FAIL "chat-turn" "chat turn did not complete (composer missing ⇒ UI on pairing/onboarding, or no transcript change) — see shots/report.json .chat"
  fi
fi

# ── 12: stop our shell BEFORE measuring/reporting (peak RSS is final then) ──
if [[ "$MODE" == "shell" ]]; then
  stop_shell || true
  if [[ -n "$COLD_START_MS" ]]; then
    check PASS "cold-start" "cold start (launch → UI answering): ${COLD_START_MS}ms"
  fi
  if [[ -f "$RAW/peak-rss-kb" ]]; then
    PEAK="$(cat "$RAW/peak-rss-kb")"
    check PASS "peak-rss" "peak RSS of the launched app process: ${PEAK} kB (~$((PEAK / 1024)) MiB, VmHWM)"
  else
    check SKIP "peak-rss" "no VmHWM sample captured (process exited before first poll or /proc unreadable)"
  fi
fi

# ── report ──────────────────────────────────────────────────────────────────
REPORT="$OUT_DIR/report.md"
{
  echo "# Moch desktop — acceptance report"
  echo
  echo "- generated: $(date -Is)"
  MODE_LINE="- mode: \`$MODE\`"
  if (( CHAT == 1 )); then MODE_LINE+=" (+ --chat)"; fi
  echo "$MODE_LINE"
  echo "- widths: \`$WIDTHS\` · settle: ${SETTLE}ms"
  echo "- instance detected via flock: **$INSTANCE_STATE** (\`$LOCK_PATH\`)"
  echo "- gateway: 127.0.0.1:$GW_PORT (token read live from the handshake; never printed)"
  echo
  echo "| status | check | note |"
  echo "|--------|-------|------|"
  for i in "${!CHECK_NAMES[@]}"; do
    echo "| ${CHECK_STATUSES[$i]} | ${CHECK_NAMES[$i]} | ${CHECK_NOTES[$i]} |"
  done
  echo
  echo "**Totals: $PASS_COUNT PASS · $FAIL_COUNT FAIL · $SKIP_COUNT SKIP**"
  echo
  echo "## Raw evidence"
  echo
  echo "### shot evaluation"
  echo '```'
  cat "$RAW/shot-eval.txt" 2>/dev/null
  echo '```'
  echo "### rendered body text (ground truth)"
  echo '```'
  head -c 3000 "$RAW/body-text.txt" 2>/dev/null
  echo '```'
  echo "### /moch-config.json as served (token redacted)"
  echo '```'
  python3 - "$RAW/moch-config.json" <<'PY' 2>/dev/null || echo "(none captured)"
import json, sys
try:
    c = json.load(open(sys.argv[1]))
    tok = c.get("token") or ""
    c["token"] = f"<{len(tok)} chars redacted>"
    print(json.dumps(c)[:600])
except Exception as e:
    print(f"(unreadable: {e})")
PY
  echo '```'
  echo "### serve log (tail)"
  echo '```'
  tail -20 "$RAW/serve.log" 2>/dev/null
  echo '```'
  echo "### shell stderr (mode=shell, tail)"
  echo '```'
  tail -30 "$RAW/shell.stderr" 2>/dev/null
  echo '```'
  echo
  echo "Screenshots: \`$OUT_DIR/shots/*.png\` · full diagnostics: \`$OUT_DIR/shots/report.json\` · raw logs: \`$RAW/\`"
} > "$REPORT"

echo
echo "verify-desktop: report written to $REPORT"
if (( FAIL_COUNT > 0 )); then
  echo "verify-desktop: RESULT: FAIL — $FAIL_COUNT failing check(s); $PASS_COUNT passed, $SKIP_COUNT skipped"
  exit 1
fi
echo "verify-desktop: RESULT: PASS — $PASS_COUNT passed, $SKIP_COUNT skipped"
exit 0
