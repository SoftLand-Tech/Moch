#!/usr/bin/env bash
# serve-app-web.sh — serve the exported app bundle (desktop/app-web) on a
# loopback port WITH a synthesized /moch-config.json, so the REAL app UI can
# be exercised against the LIVE gateway with no second shell and no
# interference with the running desktop instance.
#
# Usage: serve-app-web.sh [port]        (default 8099)
#
#   /moch-config.json is re-read from the gateway handshake file on EVERY
#   request, so a rotated token is picked up live. The gateway ws url is
#   built from the handshake's port (fallback 9118):
#       {"wsUrl":"ws://127.0.0.1:<port>/api/ws","token":"…","mode":"served", …}
#
#   Static behaviour mirrors the shell's tiny_http server: SPA fallback to
#   index.html, correct content types, no caching.
#
# Safety: read-only on desktop/runtime-home (the live agent home); it never
# writes, moves, or reconfigures anything there, and never touches the
# single-instance lock. Ctrl-C / SIGTERM shuts it down cleanly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_WEB_DIR="$DESKTOP_DIR/app-web"
HANDSHAKE="$DESKTOP_DIR/runtime-home/.moch-gateway.json"
PORT="${1:-8099}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "serve-app-web: FATAL: invalid port '$PORT'" >&2
  exit 1
fi
if [[ ! -f "$APP_WEB_DIR/index.html" ]]; then
  echo "serve-app-web: FATAL: $APP_WEB_DIR/index.html missing — run build-app-web.sh first." >&2
  exit 1
fi
if [[ ! -f "$HANDSHAKE" ]]; then
  echo "serve-app-web: FATAL: gateway handshake $HANDSHAKE not found — is the desktop gateway running?" >&2
  exit 1
fi

# Refuse to squat a busy port (e.g. the live gateway itself on 9118).
if python3 - "$PORT" <<'PY'
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
then :
else
  echo "serve-app-web: FATAL: port $PORT is already in use — pick another (arg 1)." >&2
  exit 1
fi

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "serve-app-web: serving $APP_WEB_DIR on http://127.0.0.1:$PORT/"
echo "serve-app-web: /moch-config.json -> live token from $HANDSHAKE"
echo "serve-app-web: Ctrl-C to stop."

python3 - "$APP_WEB_DIR" "$HANDSHAKE" "$PORT" <<'PY' &
import json
import os
import posixpath
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT, HANDSHAKE, PORT = sys.argv[1], sys.argv[2], int(sys.argv[3])

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
}


def moch_config_bytes():
    """Synthesize the shell's /moch-config.json from the LIVE handshake.

    Re-read on every request so a rotated token is picked up. Never writes
    to runtime-home. Mirrors lib.rs: wsUrl from the handshake port (fallback
    9118), home = the runtime home, logTail = last 12 lines of the serve log
    with token-bearing lines redacted exactly like the shell does.
    """
    home_dir = os.path.dirname(HANDSHAKE)
    port = 9118
    token = ""
    try:
        with open(HANDSHAKE, "r", encoding="utf-8") as f:
            info = json.load(f)
        port = int(info.get("port") or 9118)
        token = str(info.get("token") or "")
    except Exception as e:  # unreadable/rotating handshake: report it, don't die
        sys.stderr.write(f"serve-app-web: warning: handshake read failed: {e}\n")

    log_tail = ""
    try:
        log_path = os.path.join(home_dir, "..", ".hermes-serve.log")
        with open(os.path.abspath(log_path), "r", encoding="utf-8", errors="replace") as f:
            lines = [l.rstrip("\n") for l in f]
        kept = [
            l for l in lines
            if "MOCH_GATEWAY_INFO" not in l and (not token or token not in l)
        ]
        log_tail = "\n".join(kept[-12:])
    except Exception:
        pass

    cfg = {
        "wsUrl": f"ws://127.0.0.1:{port}/api/ws",
        "token": token,
        "mode": "served",  # honest: this is the harness server, not the shell
        "home": home_dir,
        "logTail": log_tail,
    }
    return (json.dumps(cfg) + "\n").encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "moch-serve-app-web/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("serve-app-web: %s\n" % (fmt % args))

    def _no_cache(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self._no_cache()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        # HEAD support lets checks probe without transferring bodies.
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/moch-config.json":
            self._send(200, moch_config_bytes(), "application/json")
            return

        rel = posixpath.normpath(path.lstrip("/"))
        if rel in (".", "..", "") or rel.startswith(".."):
            rel = "index.html"  # SPA fallback for "/" and traversal-ish paths

        fs = os.path.join(ROOT, *rel.split("/"))
        if os.path.isfile(fs):
            ext = os.path.splitext(fs)[1].lower()
            with open(fs, "rb") as f:
                body = f.read()
            self._send(200, body, CONTENT_TYPES.get(ext, "application/octet-stream"))
            return

        if path.startswith("/assets/") or "." in posixpath.basename(path):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return

        # SPA fallback: unknown extensionless route -> index.html
        with open(os.path.join(ROOT, "index.html"), "rb") as f:
            self._send(200, f.read(), "text/html; charset=utf-8")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


srv = Server(("127.0.0.1", PORT), Handler)
sys.stderr.write(f"serve-app-web: listening on http://127.0.0.1:{PORT}/\n")
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    srv.server_close()
PY
SERVER_PID=$!
set +e
wait "$SERVER_PID"
STATUS=$?
set -e
# 130 = SIGINT (Ctrl-C), 143 = SIGTERM: a clean, user-initiated stop.
if [[ $STATUS -eq 130 || $STATUS -eq 143 ]]; then
  echo "serve-app-web: stopped."
  exit 0
fi
exit "$STATUS"
