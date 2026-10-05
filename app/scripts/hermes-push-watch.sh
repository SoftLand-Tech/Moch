#!/usr/bin/env bash
# Hermes Pocket push watcher launcher — picks a python with `websockets` and
# forwards gateway approvals to your phone via Expo Push.
#
# Usage:
#   ./scripts/hermes-push-watch.sh --push-token 'ExponentPushToken[xxxx]'
#
# Env: HERMES_HOST (default 127.0.0.1:9119), HERMES_PORT (unused if host has
# port), HERMES_DASHBOARD_SESSION_TOKEN / HERMES_TOKEN, HERMES_EXPO_PUSH_TOKEN.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PY="$HERE/hermes-push-watch.py"

pick_python() {
  if [ -x "$HOME/.hermes/hermes-agent/venv/bin/python" ] && \
     "$HOME/.hermes/hermes-agent/venv/bin/python" -c 'import websockets' >/dev/null 2>&1; then
    echo "$HOME/.hermes/hermes-agent/venv/bin/python"
    return 0
  fi
  if python3 -c 'import websockets' >/dev/null 2>&1; then
    echo python3
    return 0
  fi
  return 1
}

# Allow --host without port + --port, mirroring hermes-pair.sh
HOST="${HERMES_HOST:-127.0.0.1}"
PORT="${HERMES_PORT:-9119}"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
case "$HOST" in
  *:* ) FULL_HOST="$HOST" ;;
  * ) FULL_HOST="$HOST:$PORT" ;;
esac

if ! PYBIN="$(pick_python)"; then
  echo "error: need python3 with the 'websockets' package." >&2
  echo "  pip install websockets" >&2
  echo "  (or run on the machine that hosts ~/.hermes/hermes-agent/venv)" >&2
  exit 1
fi

export HERMES_HOST="$FULL_HOST"
exec "$PYBIN" "$PY" --host "$FULL_HOST" "${ARGS[@]}"
