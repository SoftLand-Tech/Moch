#!/usr/bin/env bash
# Hermes Pocket pairing — prints gateway credentials + QR for the mobile app.
#
# Usage:
#   ./scripts/hermes-pair.sh [--host 192.168.1.10] [--port 9999] [--token XXX] [--tls] [--out /tmp/hermes-qr.png]
#
#   Env: HERMES_HOST, HERMES_PORT, HERMES_DASHBOARD_SESSION_TOKEN / HERMES_TOKEN
#
# The phone app: open Hermes Pocket → "Scan QR code",
# or paste the hermes://connect?... link manually (More options).
set -eu

HOST="${HERMES_HOST:-}"
PORT="${HERMES_PORT:-9999}"
TOKEN="${HERMES_DASHBOARD_SESSION_TOKEN:-${HERMES_TOKEN:-}}"
TLS="0"
OUT=""

usage() {
  echo "usage: $0 [--host IP|name] [--port PORT] [--token TOKEN] [--tls] [--out qr.png]"
  echo ""
  echo "  --host   gateway host (default: auto-detected LAN IP)"
  echo "  --port   gateway port (default: 9999, env HERMES_PORT)"
  echo "  --token  dashboard session token (env HERMES_DASHBOARD_SESSION_TOKEN)"
  echo "  --tls    use wss (Tailscale serve / public host). Default: plain ws for LAN."
  echo "  --out    save QR PNG to this path (needs python3 + qrcode + PIL)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --tls) TLS="1"; shift ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

detect_ip() {
  # Prefer a real LAN address over 127.0.0.1
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1 && return 0
  fi
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -n1 && return 0
  fi
  echo "127.0.0.1"
}

if [ -z "$HOST" ]; then
  HOST="$(detect_ip)"
fi

if [ -z "$TOKEN" ]; then
  printf "Gateway token (HERMES_DASHBOARD_SESSION_TOKEN): " >&2
  stty -echo 2>/dev/null || true
  read -r TOKEN < /dev/tty || read -r TOKEN
  stty echo 2>/dev/null || true
  echo "" >&2
fi

if [ -z "$TOKEN" ]; then
  echo "error: no token. Pass --token or set HERMES_DASHBOARD_SESSION_TOKEN." >&2
  exit 1
fi

case "$HOST" in
  *:*) HOSTPORT="$HOST" ;;
  *) HOSTPORT="$HOST:$PORT" ;;
esac

urlencode() {
  python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1" 2>/dev/null || {
    # minimal fallback (token is usually alnum)
    printf '%s' "$1"
  }
}

HENC="$(urlencode "$HOSTPORT")"
TENC="$(urlencode "$TOKEN")"
URL="hermes://connect?host=${HENC}&token=${TENC}&tls=${TLS}"

SCHEME="ws"
if [ "$TLS" = "1" ]; then SCHEME="wss"; fi

echo ""
echo "=== Hermes Pocket pairing ==="
echo "  Server : ${SCHEME}://${HOSTPORT}"
echo "  TLS    : $([ "$TLS" = "1" ] && echo yes || echo no)"
echo "  Token  : ${TOKEN:0:6}…${TOKEN: -4} (${#TOKEN} chars, full value hidden)"
echo ""
echo "  Pairing link:"
echo "  $URL"
echo ""
echo "  On the phone: open Hermes Pocket → 'Scan pairing QR' and point at the code below."
echo "  No camera? Choose 'Use pairing link' and paste the link above."
echo ""

printed_qr=0

# 1) python qrcode → ASCII in terminal (+ optional PNG)
if command -v python3 >/dev/null 2>&1 && python3 -c 'import qrcode' >/dev/null 2>&1; then
  python3 - "$URL" <<'PY' || true
import sys
url = sys.argv[1]
import qrcode
qr = qrcode.QRCode(border=1)
qr.add_data(url)
qr.make(fit=True)
qr.print_ascii(invert=True)
PY
  printed_qr=1
  if [ -n "$OUT" ]; then
    python3 - "$URL" "$OUT" <<'PY' || echo "(could not write $OUT — need pillow: pip install pillow qrcode)" >&2
import sys
url, out = sys.argv[1], sys.argv[2]
import qrcode
img = qrcode.make(url)
img.save(out)
print(f"QR saved to {out}")
PY
  fi
fi

# 2) qrencode CLI → ANSI QR
if [ "$printed_qr" = "0" ] && command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 "$URL" || true
  printed_qr=1
  if [ -n "$OUT" ]; then
    qrencode -t PNG -o "$OUT" "$URL" && echo "QR saved to $OUT"
  fi
fi

if [ "$printed_qr" = "0" ]; then
  echo "(No QR renderer found. Install one for a scannable code:)" >&2
  echo "  pip install qrcode pillow   # terminal + PNG output" >&2
  echo "  sudo apt install qrencode   # terminal QR" >&2
  if [ -n "$OUT" ]; then
    echo "error: cannot write $OUT without qrcode/pillow or qrencode." >&2
    exit 1
  fi
fi

echo ""
echo "Manual entry (if not scanning):"
echo "  host : $HOSTPORT"
echo "  tls  : $([ "$TLS" = "1" ] && echo on || echo off)"
echo "  token: (the full value you passed via --token / env)"
echo ""
echo "Tip for production/Tailscale: ./scripts/hermes-pair.sh --host myhost.tailnet.ts.net --tls"
