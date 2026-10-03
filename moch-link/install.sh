#!/usr/bin/env bash
# moch-link — expose your existing hermes agent to the Moch mobile app.
#
#   bash install.sh          link this machine's hermes serve to the Moch relay
#                            (api.moch.softland.tech) and print the pairing QR
#   ... qr                   reprint the QR
#   ... status | stop | start
#   ... uninstall            remove the unit and ~/.moch-link
#
# What it does NOT do: install, configure or modify hermes in any way. It only
# reads your serve token and dials the relay outbound — the same trust model
# as pairing a Telegram bot: your home, your data, one more door for your phone.
set -euo pipefail

RELAY="${MOCH_LINK_RELAY:-wss://api.moch.softland.tech}"
LINK_HOME="${MOCH_LINK_HOME:-$HOME/.moch-link}"
ENV_FILE_SRC="${MOCH_LINK_ENV:-}"
SERVE_PORT="${MOCH_LINK_PORT:-}"
SERVE_BIN="${MOCH_SERVE_BIN:-}"
UNITP="${MOCH_LINK_UNIT_PREFIX:-moch-link}"
UNIT_DIR="$HOME/.config/systemd/user"
VENDOR_URL="https://raw.githubusercontent.com/SoftLand-Tech/Moch/40b563304b/server/scripts/vendor/qrcodegen.py"
QRGEN="$LINK_HOME/qrcodegen.py"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[moch-link]${NC} $*"; }
success() { echo -e "${GREEN}[moch-link ✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[moch-link !]${NC} $*"; }
die()     { echo -e "${RED}[moch-link ✗]${NC} $*" >&2; exit 1; }

# --- the tunnel client (from the Moch backend, production-verified) ----------
install_tunnel() {
    mkdir -p "$LINK_HOME"
    cat > "$LINK_HOME/moch-tunnel.js" <<'MOCH_TUNNEL_JS_EOF'
#!/usr/bin/env node
// moch-tunnel — the home side of the official Moch relay.
//
// Dials the relay OUTBOUND over one control WebSocket (no router config, works
// behind any NAT), registers this machine by the sha256 of the local gateway's
// pairing token — the token itself never leaves the machine except as the
// /tunnel leg key — and then, whenever a phone knocks on wss://<relay>/api/ws,
// opens a tunnel leg and pipes raw bytes to the local gateway. The phone's
// WebSocket handshake, token included, completes end to end at the home
// gateway; the relay never interprets it.
//
//   control:  <relay>/control  {"t":"register","machine":<id>,"tokenHash":<sha256(token)>}
//             ack {"t":"registered","host":...}; knock {"t":"conn","id}, {"t":"cancel","id}
//   legs:     <relay>/tunnel/<id>?key=<gateway token>  (proves possession: the
//             service holds sha256(token) from registration)
//
// Reconnects with exponential backoff 1s -> 30s; the machine's registration at
// the relay survives disconnects, and the machine id is persisted locally so
// re-registering reuses the same slot. Writes status.json {connected, host,
// machine, relay, at} for pairinfo/qr — host is the relay hostname WITHOUT port.
//
// Requires: node >= 16 and the `ws` package next to this file.
//   moch tunnel (moch-serve.sh) sets it up, or run by hand:
//   moch-tunnel.js --relay wss://api.moch.softland.tech --token <gateway-token> \
//                  [--relay-key <key>] [--machine <id>] [--target 127.0.0.1:9223] \
//                  [--status <file>]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const WS = require('ws')

function usage(code) {
  console.error(
    'usage: moch-tunnel --token <gateway-token> [--relay wss://api.moch.softland.tech]\n' +
    '                   [--relay-key <key>] [--machine <id>] [--target 127.0.0.1:9223]\n' +
    '                   [--status <file>]')
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    relay: 'wss://api.moch.softland.tech',
    token: '',
    relayKey: '',
    machine: '',
    target: '127.0.0.1:9223',
    status: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) usage(2)
      return argv[++i]
    }
    if (a === '--relay') out.relay = String(next())
    else if (a === '--token') out.token = String(next())
    else if (a === '--relay-key') out.relayKey = String(next())
    else if (a === '--machine') out.machine = String(next())
    else if (a === '--target') out.target = String(next())
    else if (a === '--status') out.status = String(next())
    else if (a === '--help' || a === '-h') usage(0)
    else { console.error('unknown argument: ' + a); usage(2) }
  }
  return out
}

const cfg = parseArgs(process.argv.slice(2))
if (!cfg.token) { console.error('moch-tunnel: --token <gateway-token> is required'); process.exit(2) }
if (!cfg.status) cfg.status = path.join(process.env.HOME || '.', '.moch', 'tunnel', 'status.json')

let relayUrl
try { relayUrl = new URL(cfg.relay.replace(/\/+$/, '') + '/') } catch { console.error('moch-tunnel: --relay is not a valid URL:', cfg.relay); process.exit(2) }
const relayOrigin = cfg.relay.replace(/\/+$/, '')
// status.json "host": hostname plus :port when the relay is not on 443 (phones
// dial wss/ws://host); "secure" says which scheme the relay itself speaks.
const relayHost = relayUrl.hostname + (relayUrl.port && relayUrl.port !== '443' ? ':' + relayUrl.port : '')
const relaySecure = relayUrl.protocol === 'wss:'
const tokenHash = crypto.createHash('sha256').update(cfg.token).digest('hex') // only the hash goes on /control

// Stable machine id: an explicit --machine wins; otherwise generate once and
// persist it next to the status file so restarts re-register the same machine
// (the relay refuses a second machine with the same tokenHash).
if (!cfg.machine) {
  const idFile = path.join(path.dirname(cfg.status), 'machine-id')
  try { cfg.machine = fs.readFileSync(idFile, 'utf8').trim() } catch {}
  if (!cfg.machine || !/^[A-Za-z0-9._-]{1,64}$/.test(cfg.machine)) {
    cfg.machine = 'm-' + crypto.randomBytes(6).toString('hex')
    try { fs.mkdirSync(path.dirname(idFile), { recursive: true }); fs.writeFileSync(idFile, cfg.machine) } catch {}
  }
}

const log = (...m) => console.log(new Date().toISOString(), ...m)
const writeStatus = (connected) => {
  try {
    fs.mkdirSync(path.dirname(cfg.status), { recursive: true })
    fs.writeFileSync(cfg.status + '.tmp', JSON.stringify({ connected, host: relayHost, secure: relaySecure, machine: cfg.machine, relay: relayOrigin, at: Date.now() }))
    fs.renameSync(cfg.status + '.tmp', cfg.status)
  } catch {}
}

function splitTarget(t) {
  const s = String(t)
  const i = s.lastIndexOf(':')
  if (i <= 0) return { host: s || '127.0.0.1', port: 9223 }
  const port = Number(s.slice(i + 1))
  let host = s.slice(0, i)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { host: s, port: 9223 }
  return { host, port }
}
const target = splitTarget(cfg.target)

// ---- control leg -------------------------------------------------------------------

let backoffMs = 1000
let ctl = null
let lastPongAt = 0
let shuttingDown = false
const legs = new Map() // connId -> { ws, tcp, buf[], bufLen, wsOpen, inB, outB, openedAt }

function connectControl() {
  if (shuttingDown) return
  const u = new URL(relayOrigin + '/control')
  ctl = new WS(u, { maxPayload: 64 * 1024 })
  lastPongAt = Date.now()

  ctl.on('open', () => {
    log('control connected to', u.host)
    // --relay-key is only needed when the relay service runs --require-key;
    // the gateway pairing token hash is what actually routes phone sockets.
    const reg = { t: 'register', machine: cfg.machine, tokenHash }
    if (cfg.relayKey) reg.key = cfg.relayKey
    try { ctl.send(JSON.stringify(reg)) } catch {}
  })

  ctl.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString('utf8')) } catch { return }
    if (msg.t === 'registered') {
      backoffMs = 1000
      lastPongAt = Date.now()
      writeStatus(true)
      log('registered as', cfg.machine, '— relay ack host:', msg.host, '(phones dial wss://' + msg.host + '/api/ws?token=<gateway-token>)')
    } else if (msg.t === 'conn' && msg.id) {
      openLeg(String(msg.id))
    } else if (msg.t === 'cancel' && msg.id) {
      closeLeg(String(msg.id), 'cancelled by relay (phone gone)')
    } else if (msg.t === 'error') {
      log('relay refused registration:', msg.error)
      writeStatus(false)
      process.exit(1) // refusals are operator-fixable, not transient: dup tokenHash, IP cap, bad relay key
    }
  })

  ctl.on('pong', () => { lastPongAt = Date.now() })

  ctl.on('close', () => {
    if (shuttingDown) return
    log('control closed — reconnecting in', backoffMs + 'ms (registration at the relay survives)')
    writeStatus(false)
    for (const id of [...legs.keys()]) closeLeg(id, 'control lost')
    setTimeout(connectControl, backoffMs)
    backoffMs = Math.min(Math.round(backoffMs * 2), 30000) // 1s -> 30s
  })

  ctl.on('error', (e) => { log('control error:', e.message); try { ctl.terminate() } catch {} })

  // Heartbeat this leg both ways: we ping every 20s (relay auto-pongs) and
  // treat ~45s of silence as a dead path -> force reconnect.
  const hb = setInterval(() => {
    if (ctl.readyState !== WS.OPEN) return
    if (Date.now() - lastPongAt > 45000) { log('control heartbeat stale — forcing reconnect'); try { ctl.terminate() } catch {}; return }
    try { ctl.ping() } catch {}
  }, 20000)
  ctl.on('close', () => clearInterval(hb))
}

// ---- tunnel legs -------------------------------------------------------------------

function openLeg(id) {
  if (legs.has(id)) return
  const leg = { ws: null, tcp: null, buf: [], bufLen: 0, wsOpen: false, inB: 0, outB: 0, openedAt: Date.now() }
  legs.set(id, leg)

  const tu = new URL(relayOrigin + '/tunnel/' + encodeURIComponent(id))
  tu.searchParams.set('key', cfg.token) // machine secret: raw pairing token; relay checks sha256(key) === registered hash

  const tcp = net.connect({ host: target.host, port: target.port })
  // CONNECT timeout only — a one-shot timer cancelled on connect. socket
  // .setTimeout(ms, cb) would instead fire after ms of silence for the whole
  // leg's life and kill healthy idle connections every 10s (chat sitting
  // still, thinking pauses mid-turn): silence is normal, only an endpoint
  // closing ends a leg.
  const connectTimer = setTimeout(() => {
    log('tunnel', id.slice(0, 8), 'target connect timeout:', cfg.target)
    closeLeg(id, 'target connect timeout')
  }, 10_000)
  leg.tcp = tcp
  tcp.pause() // hold gateway bytes until the leg is up (bounded below; the gateway stays quiet until it gets the handshake anyway)

  tcp.on('connect', () => {
    clearTimeout(connectTimer)
    tcp.setTimeout(0)
    const ws = new WS(tu, { maxPayload: 2 * 1024 * 1024 })
    leg.ws = ws
    ws.on('open', () => {
      leg.wsOpen = true
      log('tunnel', id.slice(0, 8), 'open ->', cfg.target)
      const held = Buffer.concat(leg.buf)
      leg.buf = []
      leg.bufLen = 0
      if (held.length) ws.send(held, { binary: true })
      tcp.resume()
    })
    ws.on('message', (data) => {
      if (tcp.destroyed) return
      leg.inB += data.length
      const ok = tcp.write(data)
      if (!ok && ws._socket) ws._socket.pause()
    })
    tcp.on('drain', () => { if (leg.ws && leg.ws._socket) leg.ws._socket.resume() })
    // Keepalive on this leg: ping every 20s (relay auto-pongs); pings/pongs are
    // ws control frames and never disturb the spliced payload.
    const hb = setInterval(() => { if (ws.readyState === WS.OPEN) { try { ws.ping() } catch {} } }, 20000)
    ws.on('close', () => { clearInterval(hb); closeLeg(id, 'tunnel closed') })
    ws.on('error', (e) => { clearInterval(hb); log('tunnel', id.slice(0, 8), 'error:', e.message); closeLeg(id, 'tunnel error') })
  })

  tcp.on('data', (chunk) => {
    if (!leg.wsOpen) {
      leg.buf.push(chunk)
      leg.bufLen += chunk.length
      if (leg.bufLen > 256 * 1024) { log('tunnel', id.slice(0, 8), 'pre-open buffer overflow'); closeLeg(id, 'buffer overflow'); return }
      return
    }
    if (!leg.ws || leg.ws.readyState !== WS.OPEN) return closeLeg(id, 'tunnel not open')
    leg.outB += chunk.length
    tcp.pause() // one chunk in flight; backpressure instead of buffering
    leg.ws.send(chunk, { binary: true }, () => { if (!tcp.destroyed) tcp.resume() })
  })

  tcp.on('error', (e) => { log('tunnel', id.slice(0, 8), 'target error:', e.message); closeLeg(id, 'target error') })
  tcp.on('end', () => closeLeg(id, 'target closed'))   // gateway FIN -> tear the leg down
  tcp.on('close', () => closeLeg(id, 'target closed'))
}

function closeLeg(id, why) {
  const leg = legs.get(id)
  if (!leg) return
  legs.delete(id)
  const secs = ((Date.now() - leg.openedAt) / 1000).toFixed(1)
  log('tunnel', id.slice(0, 8), 'closed:', why, '(' + leg.outB + 'b -> gateway, ' + leg.inB + 'b -> phone, ' + secs + 's)')
  if (leg.tcp) { leg.tcp.setTimeout(0); leg.tcp.destroy() }
  if (leg.ws) { try { leg.ws.terminate() } catch {} }
}

// ---- lifecycle ---------------------------------------------------------------------

function shutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown on', sig)
  writeStatus(false)
  for (const id of [...legs.keys()]) closeLeg(id, 'client shutdown')
  if (ctl) { try { ctl.close(1001, 'client shutdown') } catch {} }
  setTimeout(() => process.exit(0), 200)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (e) => log('uncaught exception (continuing):', e && e.stack || e))

writeStatus(false)
connectControl()
MOCH_TUNNEL_JS_EOF
}

token_value() { sed -n 's/^HERMES_DASHBOARD_SESSION_TOKEN=//p' "$ENV_FILE_SRC" | head -1; }

load_state() {
    TOKEN="$(sed -n 's/^TOKEN=//p' "$LINK_HOME/env" 2>/dev/null | head -1 || true)"
    TARGET="$(sed -n 's/^TARGET=//p' "$LINK_HOME/env" 2>/dev/null | head -1 || true)"
}

find_hermes_bin() {
    local c
    for c in "$SERVE_BIN" "$(command -v hermes || true)" "$HOME/.local/bin/hermes" \
             "${HERMES_HOME:-$HOME/.hermes}/hermes-agent/venv/bin/hermes" \
             "$HOME/.hermes/hermes-agent/venv/bin/hermes"; do
        [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }
    done
    return 1
}

mint_token() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }

cmd_install() {
    command -v node >/dev/null 2>&1 || die "node not found — the relay tunnel needs it."
    command -v npm  >/dev/null 2>&1 || die "npm not found — the relay tunnel needs it."
    local launched_serve="" TOKEN="" HERMES_BIN=""
    mkdir -p "$LINK_HOME"

    # ---- 1) a live hermes serve we can reuse (any launcher style, any port):
    #         take its port from ss and its token straight from the process env —
    #         hermes has no persistent token store; whoever launches it mints it.
    local spid sport
    if [ "${MOCH_LINK_NO_DETECT:-}" != "1" ]; then
    spid="$(ss -tlnp 2>/dev/null | grep -o 'users:(("hermes",pid=[0-9]*' | head -1 | grep -o '[0-9]*$' || true)"
    if [ -n "$spid" ]; then
        sport="$(ss -tlnp 2>/dev/null | grep "pid=$spid," | head -1 | awk '{n=split($4,a,":"); print a[n]}')"
        if [ -n "$sport" ]; then
            TOKEN="$(tr '\0' '\n' < "/proc/$spid/environ" 2>/dev/null | sed -n 's/^HERMES_DASHBOARD_SESSION_TOKEN=//p' | head -1)"
            if [ -n "$TOKEN" ]; then
                SERVE_PORT="$sport"
                info "found hermes serve (pid $spid) on port $sport — reusing it, token read from its environment"
            else
                die "hermes serve is running (pid $spid) but its pairing token is not discoverable.
  Stop it (kill $spid or: systemctl --user stop hermes-serve) and re-run — moch-link
  will start its own serve with a fresh token — or point MOCH_LINK_ENV at a file
  containing HERMES_DASHBOARD_SESSION_TOKEN."
            fi
        fi
    fi

    fi

    # ---- 2) nobody is serving: we become the launcher. Token comes from the
    #         usual env files when they exist (moch / hermes-serve unit styles),
    #         otherwise we mint one — serve must run with a known token either way.
    if [ -z "${TOKEN:-}" ]; then
        # MOCH_LINK_ENV, when set, is EXCLUSIVE (an explicit pointer, not a hint)
        local envf envs
        if [ -n "$ENV_FILE_SRC" ]; then envs="$ENV_FILE_SRC"
        else envs="$HOME/.config/hermes-serve.env $HOME/.config/moch-serve.env"; fi
        for envf in $envs; do
            [ -f "$envf" ] || continue
            TOKEN="$(sed -n 's/^HERMES_DASHBOARD_SESSION_TOKEN=//p' "$envf" | head -1)"
            [ -n "$TOKEN" ] && break
        done
        if [ -n "${TOKEN:-}" ] && [ -n "$SERVE_PORT" ] \
           && (exec 3<>"/dev/tcp/127.0.0.1/$SERVE_PORT" && exec 3>&-) 2>/dev/null; then
            info "reusing serve on port $SERVE_PORT with the token from $envf"
        else
            if [ -n "$SERVE_PORT" ] \
               && (exec 3<>"/dev/tcp/127.0.0.1/$SERVE_PORT" && exec 3>&-) 2>/dev/null; then
                die "something is listening on port $SERVE_PORT but no pairing token was found
  for it. If that is your hermes serve, start it with a known token or point
  MOCH_LINK_ENV at a file containing HERMES_DASHBOARD_SESSION_TOKEN."
            fi
            HERMES_BIN="$(find_hermes_bin)" || die "hermes not found on this machine — moch-link links an
  EXISTING hermes install (it never installs hermes itself). Install it first:

    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

  then run 'hermes' once to set it up, and re-run moch-link.
  (Or point MOCH_SERVE_BIN at an existing hermes launcher.)"
            [ -n "$SERVE_PORT" ] || SERVE_PORT=9119
            [ -n "$TOKEN" ] || TOKEN="$(mint_token)"
            printf 'HERMES_DASHBOARD_SESSION_TOKEN=%s\nPORT=%s\n' "$TOKEN" "$SERVE_PORT" > "$LINK_HOME/hermes-serve.env"
            chmod 600 "$LINK_HOME/hermes-serve.env"
            mkdir -p "$UNIT_DIR"
            cat > "$UNIT_DIR/${UNITP}-hermes-serve.service" <<EOF
[Unit]
Description=Moch Link — hermes serve (started by moch-link; remove with: moch-link uninstall)
After=network-online.target

[Service]
EnvironmentFile=$LINK_HOME/hermes-serve.env
ExecStart=$HERMES_BIN serve --host 127.0.0.1 --port \${PORT}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
            systemctl --user daemon-reload
            # enable must not be fatal under set -e (its stderr would be
            # swallowed by >/dev/null and kill the script silently); the port
            # wait below is the real judge and dumps status on failure
            systemctl --user enable "${UNITP}-hermes-serve.service" >/dev/null 2>&1 || true
            systemctl --user restart "${UNITP}-hermes-serve.service" >/dev/null 2>&1 || true
            info "starting hermes serve on port $SERVE_PORT (unit ${UNITP}-hermes-serve)"
            launched_serve=1
            local i
            for i in $(seq 1 20); do
                (exec 3<>"/dev/tcp/127.0.0.1/$SERVE_PORT" && exec 3>&-) 2>/dev/null && break
                sleep 1
            done
            (exec 3<>"/dev/tcp/127.0.0.1/$SERVE_PORT" && exec 3>&-) 2>/dev/null \
                || { systemctl --user status "${UNITP}-hermes-serve.service" --no-pager -n 8 || true
                     die "hermes serve did not come up — see above (journalctl --user -u ${UNITP}-hermes-serve -n 30)"; }
        fi
    fi

    # ---- 3) sanity: something must be listening where we point the tunnel
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$SERVE_PORT" && exec 3>&-) 2>/dev/null; then
        die "nothing listening on 127.0.0.1:$SERVE_PORT — start hermes serve, then re-run."
    fi
    TARGET="127.0.0.1:$SERVE_PORT"

    mkdir -p "$LINK_HOME"
    # keep a copy of this script so qr/status/uninstall work later without
    # re-downloading (no-op when piped: $0 is just "bash" then)
    case "$0" in
        "$LINK_HOME/install.sh"|"bash") ;;
        *) [ -f "$0" ] && cp "$0" "$LINK_HOME/install.sh" ;;
    esac

    # ALWAYS refresh the tunnel script: re-running the installer is the
    # upgrade path (a file-existence gate left older installs on a buggy
    # tunnel forever — the 10s-idle-kill incident). Only npm install when
    # the dependency is actually missing.
    info "installing the relay tunnel → $LINK_HOME"
    install_tunnel
    if [ ! -d "$LINK_HOME/node_modules/ws" ]; then
        # own package.json = own npm root: without it npm climbs to the nearest
        # package.json up the tree (sometimes $HOME itself) and drags in — or
        # dies on — whatever lives there (seen live: a dead tgz path in ~/package.json)
        printf '{"name":"moch-link","private":true,"dependencies":{"ws":"^8.0.0"}}\n' > "$LINK_HOME/package.json"
        npm install --prefix "$LINK_HOME" --silent --no-audit --no-fund >/dev/null 2>&1 \
            || die "npm install ws failed — check npm, then re-run"
    fi

    # hermes serve rejects requests whose Host isn't local (any reverse front —
    # tailscale, the relay — sends its own Host). Ship a tiny host-rewrite
    # proxy in front of serve, exactly like hermes' own tailscale proxy does.
    # Stop OUR previous proxy first: a live one would win the port pick below,
    # and `enable --now` on an active unit is a no-op — the stale process would
    # keep serving its old port while everything else moved to the new one
    # (seen live: tunnel aimed at 9121, proxy still on 9120, ECONNREFUSED).
    systemctl --user stop ${UNITP}-proxy.service 2>/dev/null || true
    PROXY_PORT="${MOCH_LINK_PROXY_PORT:-9120}"
    while (exec 3<>"/dev/tcp/127.0.0.1/$PROXY_PORT" && exec 3>&-) 2>/dev/null; do
        PROXY_PORT=$((PROXY_PORT + 1))
    done
    cat > "$LINK_HOME/moch-link-proxy.js" <<'MOCH_LINK_PROXY_EOF'
#!/usr/bin/env node
// raw TCP to hermes serve with the Host/Origin rewritten to look local.
//
// Also watches the server->client byte stream PASSIVELY (it is piped on
// untouched) for the two moments the phone must hear about even with the
// app killed: the backend asking a question (approval / clarify / sudo /
// secret server->client requests) and a turn ending (the message.complete
// event), then fires an Expo push at the token the phone registered on its
// upgrade request line (?push=<token>). Wire shapes this matches are the
// gateway's own: a request is {"jsonrpc": "2.0", "id": "srq-…", "method":
// "approval"|"clarify"|"sudo"|"secret", "params": {"session_id": …, …}};
// an event is {"jsonrpc": "2.0", "method": "event", "params": {"type":
// "message.complete", "session_id": …, "payload": …, "seq": …}}.
const net = require('node:net')
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const UP_HOST = process.env.UP_HOST || '127.0.0.1'
const UP_PORT = parseInt(process.env.UP_PORT || '9119', 10)
const LISTEN = parseInt(process.env.LISTEN || '9120', 10)
// the unit runs us with WorkingDirectory=$LINK_HOME and LINK_HOME in the
// env file; cwd is the fallback for by-hand runs
const LINK_HOME = process.env.LINK_HOME || process.cwd()
const PUSH_URL = process.env.EXPUSH_URL || 'https://exp.host/--/api/v2/push/send'

// ---- push registration ------------------------------------------------------
const TOKEN_FILE = path.join(LINK_HOME, 'push-token')
let pushToken = ''
try { pushToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}

/** Remember the phone's Expo push token. Single-phone-per-machine by design:
 *  the pairing token routes ONE machine, and the app registers on every dial
 *  (last dial wins). The token is a standing push capability — 0600, like the
 *  sibling secrets in this directory. Rotation is normal — just overwrite. */
function registerPushToken(tok) {
  if (!tok || tok === pushToken) return
  pushToken = tok
  try { fs.writeFileSync(TOKEN_FILE, tok + '\n', { mode: 0o600 }) } catch (e) { console.error('moch-link-proxy: cannot write push-token:', e.message) }
}

// ---- push sender ------------------------------------------------------------
const NOTIFS = {
  waiting: { title: 'Mochi needs you', body: 'Mochi is waiting for your approval.', channelId: 'approvals', collapseKey: 'approvals' },
  clarify: { title: 'Mochi asked something', body: 'Mochi is waiting for your answer.', channelId: 'approvals', collapseKey: 'approvals' },
  replied: { title: 'Mochi replied', body: 'Mochi finished your request.', channelId: 'replies', collapseKey: 'replies' },
}
const THROTTLE_MS = 30000 // one POST per collapseKey per window: a single turn can match several times
const lastSentBy = new Map() // collapseKey -> ms of the last POST

function sendPush(kind, sessionId) {
  if (!pushToken) return
  const now = Date.now()
  if (now - (lastSentBy.get(kind.collapseKey) || 0) < THROTTLE_MS) return
  lastSentBy.set(kind.collapseKey, now)
  const data = { screen: 'chat' }
  if (sessionId) data.storedId = sessionId // deep-link target; the app swallows unknown ids
  const body = JSON.stringify({ to: pushToken, title: kind.title, body: kind.body, channelId: kind.channelId, data, ttl: 604800, collapseKey: kind.collapseKey })
  const fail = (e) => console.error('moch-link-proxy: push send failed:', (e && e.message) || e)
  if (typeof fetch === 'function') { // node >= 18: global fetch, fire-and-forget
    const ac = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), 5000) : null
    fetch(PUSH_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...(ac ? { signal: ac.signal } : {}) })
      .then((r) => { if (!r.ok) console.error('moch-link-proxy: push endpoint answered', r.status) })
      .catch(fail)
      .finally(() => { if (timer) clearTimeout(timer) })
    return
  }
  try { // older node: plain http/https module
    const u = new URL(PUSH_URL)
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); if (res.statusCode >= 300) console.error('moch-link-proxy: push endpoint answered', res.statusCode) })
    req.setTimeout(5000, () => req.destroy(new Error('push send timed out')))
    req.on('error', fail)
    req.end(body)
  } catch (e) { fail(e) }
}

// ---- server->client WS frame watcher ----------------------------------------
// Server frames are UNMASKED (RFC 6455: a server must not mask), so a minimal
// header parse recovers whole text messages: 2-14 byte header (7-bit length,
// 126 -> uint16, 127 -> uint64), opcode 0x1 text / 0x0 continuation; ping /
// pong / binary / close are skipped; frames split across TCP chunks are
// reassembled by buffering until a complete frame is in hand.
const MAX_MSG = 16 * 1024 * 1024

function makeTextFrameReader(onText) {
  let pending = Buffer.alloc(0) // bytes not yet parsed into a complete frame
  let frags = []                // payload fragments of an unfinished text message
  let inText = false
  // The upstream's FIRST bytes are the HTTP/1.1 101 Switching Protocols
  // response (headers + \r\n\r\n), not a frame: parsing them as frame headers
  // desyncs the reader from byte 0 and no notification is ever matched. Skip
  // the response head once per connection, then parse frames.
  let preamble = true
  return function feed(chunk) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    if (preamble) {
      const at = pending.indexOf('\r\n\r\n')
      if (at < 0) return // head still arriving
      pending = pending.subarray(at + 4)
      preamble = false
    }
    for (;;) {
      if (pending.length < 2) return
      const fin = (pending[0] & 0x80) !== 0
      const op = pending[0] & 0x0f
      let len = pending[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (pending.length < 4) return
        len = pending.readUInt16BE(2); off = 4
      } else if (len === 127) {
        if (pending.length < 10) return
        const big = pending.readBigUInt64BE(2)
        if (big > BigInt(MAX_MSG)) { pending = Buffer.alloc(0); frags = []; inText = false; return } // absurd: drop parse state, never mis-split the pipe
        len = Number(big); off = 10
      }
      if (pending[1] & 0x80) { pending = Buffer.alloc(0); frags = []; inText = false; return } // masked: servers never mask — resync is hopeless, drop state
      if (pending.length < off + len) return // frame split across chunks: wait for the rest
      const payload = pending.subarray(off, off + len)
      pending = pending.subarray(off + len)
      if (op === 0x1) {
        frags = [payload]; inText = true
        if (fin) { const whole = Buffer.concat(frags); frags = []; inText = false; try { onText(whole) } catch {} }
      } else if (op === 0x0 && inText) {
        frags.push(payload)
        if (fin) { const whole = Buffer.concat(frags); frags = []; inText = false; try { onText(whole) } catch {} }
      }
      // 0x2 binary, 0x8 close, 0x9 ping, 0xA pong: ignored
    }
  }
}

// Structural match, exactly like the phone's own decoder: a frame with a
// string id + a method that isn't "event" is a server->client request; a
// notification with method "event" carries the event name in params.type.
// NOT a substring match: request.cancel embeds the withdrawn request's
// "method": "approval" inside its event payload, and that must not buzz.
const ASK_METHODS = new Set(['approval', 'clarify', 'sudo', 'secret'])

function onGatewayText(payloadBuf) {
  let text = ''
  try { text = payloadBuf.toString('utf8') } catch { return }
  let f = null
  try { f = JSON.parse(text) } catch { f = null }
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    if (typeof f.id === 'string' && typeof f.method === 'string' && f.method !== 'event') {
      if (ASK_METHODS.has(f.method)) {
        const p = (f.params && typeof f.params === 'object') ? f.params : {}
        sendPush(f.method === 'clarify' ? NOTIFS.clarify : NOTIFS.waiting, typeof p.session_id === 'string' ? p.session_id : undefined)
      }
      return
    }
    if (f.method === 'event') {
      const p = f.params
      if (p && typeof p === 'object' && p.type === 'message.complete') {
        sendPush(NOTIFS.replied, typeof p.session_id === 'string' ? p.session_id : undefined)
      }
    }
    return
  }
  // Not valid JSON (not a gateway frame): conservative substring fallback.
  // The gateway serializes with json.dumps defaults, so '"method": "approval"'
  // (space after the colon) is the on-wire shape; request.cancel is excluded.
  if (text.includes('"type": "request.cancel"')) return
  const sid = (text.match(/"session_id": "([^"]+)"/) || [])[1]
  if (text.includes('"method": "approval"') || text.includes('"method": "sudo"') || text.includes('"method": "secret"')) sendPush(NOTIFS.waiting, sid)
  else if (text.includes('"method": "clarify"')) sendPush(NOTIFS.clarify, sid)
  else if (text.includes('"type": "message.complete"')) sendPush(NOTIFS.replied, sid)
}

net.createServer((sock) => {
  const up = net.connect(UP_PORT, UP_HOST)
  const feed = makeTextFrameReader(onGatewayText)
  let first = true
  sock.on('data', (d) => {
    if (first) {
      first = false
      let s = d.toString('latin1')
      // push registration: the phone's WS upgrade request line carries
      // ?push=<Expo token>, URL-ENCODED by the app ('ExponentPushToken%5B…%5D')
      // — the capture class must accept %, and the value is decoded before use.
      const line = s.slice(0, s.indexOf('\n'))
      const m = line && line.match(/[?&]push=([A-Za-z0-9_%:-]+)/)
      if (m) {
        let tok = m[1]
        try { tok = decodeURIComponent(tok) } catch {}
        registerPushToken(tok)
      }
      s = s.replace(/^(Host:)[^\r\n]*/im, `$1 ${UP_HOST}:${UP_PORT}`)
      s = s.replace(/^(Origin:)[^\r\n]*/im, `$1 http://${UP_HOST}:${UP_PORT}`)
      up.write(Buffer.from(s, 'latin1'))
    } else up.write(d)
  })
  up.on('data', (d) => { try { feed(d) } catch {} ; sock.write(d) }) // watch, then pipe on untouched
  const kill = () => { try { sock.destroy(); up.destroy() } catch {} }
  sock.on('error', kill); up.on('error', kill)
  sock.on('close', () => up.destroy()); up.on('close', () => sock.destroy())
}).listen(LISTEN, '127.0.0.1', () => console.log(`moch-link-proxy ${LISTEN} -> ${UP_HOST}:${UP_PORT} (host-rewrite, push-watch)`))
MOCH_LINK_PROXY_EOF

    printf 'TOKEN=%s\nTARGET=127.0.0.1:%s\nRELAY=%s\nUP_PORT=%s\nLISTEN=%s\nLINK_HOME=%s\n' \
        "$TOKEN" "$PROXY_PORT" "$RELAY" "$SERVE_PORT" "$PROXY_PORT" "$LINK_HOME" > "$LINK_HOME/env"
    chmod 600 "$LINK_HOME/env"

    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/${UNITP}-proxy.service" <<EOF
[Unit]
Description=Moch Link — host-rewrite proxy in front of hermes serve
After=network-online.target

[Service]
WorkingDirectory=$LINK_HOME
EnvironmentFile=$LINK_HOME/env
ExecStart=/usr/bin/env node $LINK_HOME/moch-link-proxy.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
    cat > "$UNIT_DIR/${UNITP}.service" <<EOF
[Unit]
Description=Moch Link — hermes serve via the Moch relay (api.moch.softland.tech)
After=network-online.target ${UNITP}-proxy.service

[Service]
WorkingDirectory=$LINK_HOME
EnvironmentFile=$LINK_HOME/env
ExecStart=/usr/bin/env node $LINK_HOME/moch-tunnel.js --relay \$RELAY --token \$TOKEN --target \$TARGET --status $LINK_HOME/status.json
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    # units were rewritten → always restart (enable --now alone leaves an
    # already-active unit on its old ExecStart/env — the moch backend's lesson)
    systemctl --user enable ${UNITP}-proxy.service ${UNITP}.service >/dev/null 2>&1 || true
    systemctl --user restart ${UNITP}-proxy.service
    systemctl --user restart ${UNITP}.service

    info "connecting to the relay (outbound — no router config needed)…"
    local i connected=""
    for i in $(seq 1 20); do
        if grep -q '"connected": *true' "$LINK_HOME/status.json" 2>/dev/null; then connected=1; break; fi
        sleep 1
    done
    # (no `grep -q` here: it exits on first match, SIGPIPEs journalctl, and
    #  pipefail turns the whole condition false exactly when it should fire)
    local dup_log
    dup_log="$(journalctl --user -u ${UNITP}.service --since '-3 min' --no-pager 2>/dev/null || true)"
    if [ -z "$connected" ] && printf '%s' "$dup_log" | grep 'duplicate tokenHash' >/dev/null; then
        # The token is already registered LIVE at the relay — either this machine
        # already exposes it (e.g. the moch backend's own tunnel), or the token
        # came from a cloned image and belongs to another machine.
        if [ -n "$launched_serve" ]; then
            info "token already in use elsewhere (cloned machine?) — minting a fresh identity for this machine"
            TOKEN="$(mint_token)"
            printf 'HERMES_DASHBOARD_SESSION_TOKEN=%s\nPORT=%s\n' "$TOKEN" "$SERVE_PORT" > "$LINK_HOME/hermes-serve.env"
            printf 'TOKEN=%s\nTARGET=%s\nRELAY=%s\nUP_PORT=%s\nLISTEN=%s\nLINK_HOME=%s\n' \
                "$TOKEN" "127.0.0.1:$PROXY_PORT" "$RELAY" "$SERVE_PORT" "$PROXY_PORT" "$LINK_HOME" > "$LINK_HOME/env"
            chmod 600 "$LINK_HOME/env" "$LINK_HOME/hermes-serve.env"
            systemctl --user restart ${UNITP}-hermes-serve.service ${UNITP}.service
            for i in $(seq 1 20); do
                grep -q '"connected": *true' "$LINK_HOME/status.json" 2>/dev/null && { connected=1; break; }
                sleep 1
            done
            [ -n "$connected" ] || { systemctl --user status ${UNITP}.service --no-pager -n 8 || true; die "still not connected — see above"; }
        else
            # Their serve, their token, already exposed by a live tunnel (on this
            # machine or wherever the token came from): the registration IS the
            # link. Drop our duplicate tunnel and just use it.
            systemctl --user disable --now ${UNITP}.service >/dev/null 2>&1 || true
            printf '{"connected":true,"host":"%s","secure":true,"machine":"(reused existing registration)","relay":"%s"}\n' \
                "${RELAY#wss://}" "$RELAY" > "$LINK_HOME/status.json"
            success "this hermes is already linked to the relay by another tunnel — reusing that link"
            warn "the token is already live elsewhere (cloned machine?): the QR below reaches whichever
  machine registered it first. For THIS machine to have its own identity,
  restart its hermes serve with a fresh token and re-run moch-link."
            cmd_qr
            return 0
        fi
    fi
    if [ -z "$connected" ]; then
        # a refused registration must not leave a crash-looping unit hammering
        # the relay every 3s forever — park it until the user re-runs
        systemctl --user disable --now ${UNITP}.service >/dev/null 2>&1 || true
        systemctl --user status ${UNITP}.service --no-pager -n 8 || true
        die "tunnel did not connect — see the unit log above (fix it, then re-run moch-link)"
    fi
    success "linked — your hermes is reachable from any network via the Moch relay"
    [ -n "$launched_serve" ] && info "note: moch-link started hermes serve for you (unit ${UNITP}-hermes-serve)"
    cmd_qr
}

qr_host() { sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' "$LINK_HOME/status.json" 2>/dev/null | head -1; }

cmd_qr() {
    load_state
    [ -n "${TOKEN:-}" ] || die "not installed — run: bash install.sh"
    local host; host="$(qr_host)"
    [ -n "$host" ] || host="$(sed -n 's/^RELAY=//p' "$LINK_HOME/env" 2>/dev/null | head -1 | sed 's|^wss://||')"
    [ -n "$host" ] || die "tunnel not connected — try: systemctl --user restart ${UNITP}.service"
    echo -e "${BOLD}═══════════════ hermes, on your phone ═══════════════${NC}"
    echo
    # Label the phone's saved entry after THIS machine: many machines share
    # the relay host, so the app keys saved computers by token and needs a
    # name to tell them apart.
    MACHINE="${MOCH_LINK_NAME:-$(uname -n 2>/dev/null || echo hermes)}"
    NAME_ENC=$(printf '%s' "$MACHINE" | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' 2>/dev/null || printf '%s' "$MACHINE" | tr -c 'A-Za-z0-9._-' '-')
    if [ ! -f "$QRGEN" ]; then
        curl -fsSL "$VENDOR_URL" -o "$QRGEN" 2>/dev/null || warn "QR renderer unavailable — pair with the text values below"
    fi
    if [ -f "$QRGEN" ] && command -v python3 >/dev/null 2>&1; then
        python3 - "$QRGEN" "$host" "$TOKEN" "$NAME_ENC" <<'PY' || warn "QR rendering failed — use the text values below"
import sys
sys.path.insert(0, sys.argv[1].rsplit("/", 1)[0])
from qrcodegen import QrCode
payload = "hermes://connect?host=%s&tls=1&token=%s&name=%s" % (sys.argv[2], sys.argv[3], sys.argv[4])
q = QrCode.encode_text(payload, QrCode.Ecc.MEDIUM)
b, get = q.get_size(), q.get_module
for y in range(-2, b + 2, 2):
    print("".join(
        "█" if (get(x, y) if 0 <= x < b and 0 <= y < b else False)
             and (get(x, y + 1) if 0 <= x < b and 0 <= y + 1 < b else False)
        else "▀" if (get(x, y) if 0 <= x < b and 0 <= y < b else False)
        else "▄" if (get(x, y + 1) if 0 <= x < b and 0 <= y + 1 < b else False)
        else " "
        for x in range(-2, b + 2)))
PY
    else
        warn "python3 not found — pair with the text values below"
    fi
    echo
    echo " Scan this in the Moch app (or add a computer manually):"
    echo -e "   Host:  ${BOLD}wss://$host${NC}"
    echo -e "   Token: ${BOLD}$TOKEN${NC}"
    echo -e "   Name:  ${BOLD}$MACHINE${NC}"
    echo -e "   Link:  ${BOLD}hermes://connect?host=$host&tls=1&token=$TOKEN&name=$NAME_ENC${NC}"
    echo
    echo " Works from any network. Your sessions, providers and skills are"
    echo " already there — this is the same hermes, one more door for your phone."
    echo -e "${BOLD}═════════════════════════════════════════════════════${NC}"
}

cmd_status() {
    systemctl --user is-active --quiet ${UNITP}.service 2>/dev/null && echo "service: active" || echo "service: $(systemctl --user is-active ${UNITP}.service 2>&1)"
    cat "$LINK_HOME/status.json" 2>/dev/null || echo "(no status yet)"
}

case "${1:-}" in
    "")           cmd_install ;;
    qr)           cmd_qr ;;
    status)       cmd_status ;;
    stop)         systemctl --user stop ${UNITP}.service ${UNITP}-proxy.service 2>/dev/null || true ;;
    start)        systemctl --user start ${UNITP}-proxy.service ${UNITP}.service 2>/dev/null || true ;;
    uninstall)    systemctl --user disable --now ${UNITP}.service ${UNITP}-proxy.service ${UNITP}-hermes-serve.service 2>/dev/null || true
                  rm -f "$UNIT_DIR/${UNITP}.service" "$UNIT_DIR/${UNITP}-proxy.service" "$UNIT_DIR/${UNITP}-hermes-serve.service"
                  systemctl --user daemon-reload
                  rm -rf "$LINK_HOME"
                  success "removed — hermes itself untouched (if moch-link started a serve for you, that stops too)" ;;
    *)            echo "usage: bash install.sh [qr|status|stop|start|uninstall]"; exit 2 ;;
esac
