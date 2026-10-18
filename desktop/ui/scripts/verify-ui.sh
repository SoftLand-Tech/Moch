#!/usr/bin/env bash
# One-command live verification of the desktop UI, browser track.
#
# Boots the real gateway (desktop/runtime) and the vite dev server against a
# private state dir, renders the shell in headless chromium through the
# dev-bridge, writes a DOM dump and a screenshot, then tears everything down.
# Recipe: orchestrate/moch-desktop-rakazo/reports/R0-recon.md section 6.
#
# Every run owns an isolated slice: a /tmp/moch-verify.<worktree>.<pid>.* root
# and an OS-assigned vite port, so parallel runs from parallel worktrees
# cannot touch each other.
#
# Usage: desktop/ui/scripts/verify-ui.sh [screenshot.png]
#   MOCH_KEEP=1      skip teardown, leave gateway + dev server up for debugging
#                     (the next run reclaims what this one left behind)
#   MOCH_IMPORT_FROM hermes home the gateway imports provider config from on
#                     first run (default ~/.hermes when present)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
UI_DIR="$REPO_ROOT/desktop/ui"
RUNTIME_DIR="$REPO_ROOT/desktop/runtime"
URL=""
BUDGET=9000
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_PNG="${1:-$REPO_ROOT/.devtest/rakazo/$STAMP.png}"
OUT_DOM="${OUT_PNG%.png}.dom.html"

# Run identity: worktree name plus this script's pid. Concurrent units live
# in concurrent worktrees, so the name namespaces the temp roots and the pid
# separates a live sibling's root from an abandoned one.
IDENT="$(printf '%s' "$(basename "$REPO_ROOT")" | tr -c 'A-Za-z0-9-' '-')"
WORK="$(mktemp -d "/tmp/moch-verify.${IDENT}.$$.XXXXXX")"
STATE="$WORK/state"
VENV="$WORK/venv"
GW_PGD=""
VITE_PGD=""

die() {
  echo "verify-ui: $*" >&2
  local lg
  for lg in "$WORK"/*.log; do
    [ -f "$lg" ] || continue
    echo "--- tail of $lg ---" >&2
    tail -n 25 "$lg" >&2 || true
  done
  exit 1
}

wait_for() {
  local desc="$1"; shift
  local i
  for i in $(seq 1 120); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  die "timed out waiting for $desc"
}

# A SIGKILLed or MOCH_KEEP=1 run leaves services and a temp root behind.
# Reclaim only same-worktree roots whose creating script is dead; a foreign
# root (different worktree name) or a live sibling's (creator pid running)
# is never touched. Service identity is the leader's /proc starttime, not
# its cmdline: the npm->vite launch chain re-execs through shims, so a
# cmdline snapshot taken right after spawn no longer matches minutes later.
leader_start() {
  awk '{ s=$0; sub(/.*\)/, "", s); split(s, a, " "); print a[20] }' "/proc/$1/stat" 2>/dev/null
}

reclaim_stale_runs() {
  local old owner pf pgid recorded
  for old in /tmp/moch-verify."$IDENT".*; do
    [ -d "$old" ] || continue
    [ "$old" = "$WORK" ] && continue
    owner="${old#/tmp/moch-verify.$IDENT.}"
    owner="${owner%%.*}"
    case "$owner" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$owner" 2>/dev/null && continue
    for pf in "$old"/pids/*.pgid; do
      [ -f "$pf" ] || continue
      pgid="$(sed -n '1p' "$pf" 2>/dev/null || true)"
      recorded="$(sed -n '2p' "$pf" 2>/dev/null || true)"
      [ -n "$pgid" ] && [ -n "$recorded" ] || continue
      if [ "$(leader_start "$pgid")" = "$recorded" ]; then
        kill -TERM -- "-$pgid" 2>/dev/null || true
      fi
    done
    pkill -TERM -f "$old" 2>/dev/null || true
    rm -rf -- "$old"
  done
}

record_svc() {
  printf '%s\n%s\n' "$2" "$(leader_start "$2")" >"$WORK/pids/$1.pgid"
}

cleanup() {
  if [ "${MOCH_KEEP:-0}" = "1" ]; then
    echo "MOCH_KEEP=1: gateway + dev server left running at $URL; state and logs under $WORK" >&2
    return 0
  fi
  local pgid
  for pgid in $GW_PGD $VITE_PGD; do
    [ -n "$pgid" ] || continue
    kill -TERM -- "-$pgid" 2>/dev/null || true
  done
  # the dev-bridge spawns a chromium whose only handle back to us is the
  # state-dir path on its command line
  pkill -TERM -f "$WORK" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    curl -fsS --max-time 1 -o /dev/null "$URL/" 2>/dev/null || break
    sleep 0.5
  done
  for pgid in $GW_PGD $VITE_PGD; do
    [ -n "$pgid" ] || continue
    kill -KILL -- "-$pgid" 2>/dev/null || true
  done
  rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$STATE" "$WORK/pids" "$(dirname "$OUT_PNG")"
reclaim_stale_runs

echo "[1/6] npm ci (desktop/ui)"
(cd "$UI_DIR" && npm ci --no-audit --no-fund)

echo "[2/6] uv venv + requirements (desktop/runtime)"
uv venv --python 3.12 "$VENV"
uv pip install -q -p "$VENV/bin/python" -r "$RUNTIME_DIR/requirements.txt"

echo "[3/6] gateway (state under $STATE)"
# setsid gives each service its own process group, so teardown can kill the
# whole tree (npm->vite, gateway children) without touching this script.
# MOCH_WORKSPACE keeps the gateway's default ~/Moch out of the user's home.
# --import-from seeds the fresh state dir with a provider; without it every
# bot-dependent check dies with "not connected to any AI provider".
IMPORT_ARGS=()
if [ -n "${MOCH_IMPORT_FROM:-}" ]; then
  IMPORT_ARGS=(--import-from "$MOCH_IMPORT_FROM")
elif [ -d "$HOME/.hermes" ]; then
  IMPORT_ARGS=(--import-from "$HOME/.hermes")
fi
(cd "$RUNTIME_DIR" && exec setsid env \
  MOCH_DESKTOP_STATE_DIR="$STATE" \
  MOCH_WORKSPACE="$STATE/workspace" \
  PYTHONDONTWRITEBYTECODE=1 \
  "$VENV/bin/python" -m moch_desktop --port 0 "${IMPORT_ARGS[@]}") >"$WORK/gateway.log" 2>&1 &
GW_PGD=$!
record_svc gateway "$GW_PGD"

echo "[4/6] vite dev server (OS-assigned port)"
# port 0 asks the kernel for a free port, so parallel runs never fight over
# 5173; vite prints the bound port in its "Local:" line
(cd "$UI_DIR" && exec setsid env \
  MOCH_DESKTOP_STATE_DIR="$STATE" \
  npm run dev -- --port 0) >"$WORK/vite.log" 2>&1 &
VITE_PGD=$!
record_svc vite "$VITE_PGD"

wait_for "gateway state file" test -s "$STATE/desktop-runtime.json"
# fail fast on leader death rather than timing out on the port/readiness curls
VITE_PORT=""
for i in $(seq 1 120); do
  VITE_PORT="$(sed -n 's/.*localhost:\([0-9][0-9]*\)\/.*/\1/p' "$WORK/vite.log" 2>/dev/null | head -n1)"
  [ -n "$VITE_PORT" ] && break
  kill -0 "$VITE_PGD" 2>/dev/null || die "vite exited early"
  sleep 0.5
done
[ -n "$VITE_PORT" ] || die "timed out waiting for vite to report its port"
URL="http://localhost:$VITE_PORT"
vite_up=0
for i in $(seq 1 120); do
  if curl -fsS --max-time 2 "$URL/" >/dev/null 2>&1; then vite_up=1; break; fi
  kill -0 "$VITE_PGD" 2>/dev/null || die "vite exited early"
  sleep 0.5
done
[ "$vite_up" = 1 ] || die "timed out waiting for vite dev server"
wait_for "dev-bridge runtime-state" bash -c "curl -fsS --max-time 2 '$URL/dev-bridge/runtime-state' | grep -q '\"port\"'"
GW_PORT="$(sed -n 's/.*\"port\": \([0-9]\+\).*/\1/p' "$STATE/desktop-runtime.json" | head -n1)"
echo "[5/6] dev-bridge serving runtime state (gateway port $GW_PORT)"

echo "[6/6] render + assertions (virtual time budget ${BUDGET}ms)"
chromium --headless --disable-gpu --no-sandbox --user-data-dir="$WORK/render-dom-profile" \
  --virtual-time-budget="$BUDGET" --window-size=1600,1000 \
  --dump-dom "$URL" >"$OUT_DOM" 2>"$WORK/render-dom.log"
chromium --headless --disable-gpu --no-sandbox --user-data-dir="$WORK/render-png-profile" \
  --virtual-time-budget="$BUDGET" --window-size=1600,1000 \
  --screenshot="$OUT_PNG" "$URL" 2>"$WORK/render-png.log"

grep -q 'viewwrap' "$OUT_DOM" || die "boot never reached the ready shell; DOM dump kept at $OUT_DOM"
# the splash <style> block stays in head forever, so match the element itself
if grep -q 'id="boot-splash"' "$OUT_DOM"; then
  die "boot splash element never removed; dump kept at $OUT_DOM"
fi
[ "$(wc -c <"$OUT_PNG")" -gt 10240 ] || die "screenshot is suspiciously small; kept at $OUT_PNG"

echo "dom: $OUT_DOM ($(wc -c <"$OUT_DOM") bytes)"
echo "screenshot: $OUT_PNG ($(wc -c <"$OUT_PNG") bytes)"
echo "verify-ui: ok"
