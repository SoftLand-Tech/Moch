#!/usr/bin/env node
// moch-relay-server — the official Moch relay service.
//
//   phone                 relay (this file)              home machine (moch-tunnel.js)
//   --ws /api/ws---------->  sha256(T) -> machine   --{"t":"conn","id"}--> /control ws
//      token: header        phone socket parked      <--ws /tunnel/<id>------
//      (query = legacy)                              key: X-Moch-Tunnel-Key header
//                           RAW byte splice phone socket <-> tunnel socket
//
// The phone's WebSocket handshake is reconstructed from its original request
// line/headers and reaches the home gateway; the home gateway does the real
// 401/101. When the phone authenticated via header (see /api/ws below), the
// relay appends ?token=&push= to the FORWARDED request line — the values were
// already in relay memory and ride only the tunnel leg, never a URL on the
// relay's own front door or an access log there. The relay MAY see the raw
// token in memory on the phone leg; it is never written to disk — state.json
// stores only sha256 hashes (mode 0600).
//
// Endpoints (single port, behind a TLS terminator in production — the public
// base is wss://api.moch.softland.tech:443; plain ws://host:<port> for tests):
//   GET  /health                 -> {"ok":true} unauthenticated. The
//        "machines"/"connections" counts need the relay key (?key= or
//        X-Moch-Relay-Key header) when the service runs --require-key;
//        they are omitted otherwise.
//   ws   /control                machine -> service. Register:
//        {"t":"register","machine":<id>,"tokenHash":<hex sha256 of gateway pairing token>}
//        (add "key":<relay-key> when the service runs --require-key)
//        A register that would CREATE a credential or TAKE OVER a hash
//        (unknown machine id, new hash for a known id, or re-pairing a hash
//        held by an offline twin) must first prove possession of the raw
//        token: the service sends {"t":"verify","nonce":<hex>} and the
//        machine opens /tunnel/<nonce> with the raw token (see below) within
//        the verify window; failure -> close(4003,'verify failed'). Machines
//        whose exact (id, tokenHash) pair is already registered just re-ack.
//        Service acks {"t":"registered","host":<public host>}. Machine stays
//        'online' while the socket lives; offline on close (registration kept).
//        Service -> machine: {"t":"conn","id":<uuid>}, {"t":"cancel","id":<uuid>}.
//        Sockets that never register are closed (4001) after --register-timeout-ms.
//   ws   /api/ws                 phone -> service. Token arrives in the
//        X-Hermes-Session-Token header (or Authorization: Bearer; the query
//        ?token= form is legacy, still accepted for old clients). No
//        handshake of our own: unknown hash or offline machine -> 401 before
//        upgrade; else the machine has 15s to open the tunnel leg, then raw
//        splice.
//   ws   /tunnel/<connId>        machine -> service. The machine secret is
//        the raw gateway pairing token, sent in the X-Moch-Tunnel-Key header
//        (?key= in the query is legacy, still accepted) — the service proves
//        it by sha256(key) === registered tokenHash. The same leg keyed by a
//        verify nonce discharges a pending registration challenge.
//
// Registration is open by default with limits (max-machines-per-IP, pending
// phone conns per machine, 15s tunnel-request timeout) — OPEN REGISTRATION IS
// DEPRECATED and will require a key in a future release; --require-key
// switches now, --open-registration opts in explicitly and silences the boot
// deprecation notice. Machines persist in a JSON state file (in-memory map +
// atomic tmp/rename writes, 0600 file in a 0700 dir).
//
// Requires: node >= 16 and the `ws` package next to this file.
//   moch relay (moch-serve.sh / the deployer) installs the unit + ws.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const WS = require('ws')
const { WebSocketServer } = WS

// ---- CLI -------------------------------------------------------------------------

function usage(code) {
  console.error(
    'usage: moch-relay-server [--port 9591] [--host api.moch.softland.tech]\n' +
    '                         [--bind <listen addr>] [--state <file>]\n' +
    '                         [--require-key <key>] [--open-registration]\n' +
    '                         [--max-machines-per-ip 20] [--max-pending 200]\n' +
    '                         [--register-timeout-ms 10000] [--verify-timeout-ms 15000]\n' +
    '\n' +
    '  --bind defaults to all interfaces. Behind nginx on the same host, bind\n' +
    '  127.0.0.1 so the plain-HTTP port is not directly reachable.')
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    port: 9591,
    host: 'api.moch.softland.tech',
    bind: '',                   // '' = all interfaces (previous default)
    state: '',
    requireKey: '',
    openRegistration: false,
    maxMachinesPerIp: 20,   // whole households/campuses share one NAT IP — cap abuse, not families
    maxPending: 200,
    registerTimeoutMs: 10_000,
    verifyTimeoutMs: 15_000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) usage(2)
      return argv[++i]
    }
    if (a === '--port') out.port = Number(next())
    else if (a === '--host') out.host = String(next())
    else if (a === '--bind') out.bind = String(next())
    else if (a === '--state') out.state = String(next())
    else if (a === '--require-key') out.requireKey = String(next())
    else if (a === '--open-registration') out.openRegistration = true
    else if (a === '--max-machines-per-ip') out.maxMachinesPerIp = Number(next())
    else if (a === '--max-pending') out.maxPending = Number(next())
    else if (a === '--register-timeout-ms') out.registerTimeoutMs = Number(next())
    else if (a === '--verify-timeout-ms') out.verifyTimeoutMs = Number(next())
    else if (a === '--help' || a === '-h') usage(0)
    else { console.error('unknown argument: ' + a); usage(2) }
  }
  return out
}

const cfg = parseArgs(process.argv.slice(2))
if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) { console.error('moch-relay-server: --port must be 1..65535'); process.exit(2) }
if (!cfg.host) { console.error('moch-relay-server: --host must not be empty'); process.exit(2) }
if (!Number.isInteger(cfg.maxMachinesPerIp) || cfg.maxMachinesPerIp < 1) { console.error('moch-relay-server: --max-machines-per-ip must be >= 1'); process.exit(2) }
if (!Number.isInteger(cfg.maxPending) || cfg.maxPending < 1) { console.error('moch-relay-server: --max-pending must be >= 1'); process.exit(2) }
if (!Number.isInteger(cfg.registerTimeoutMs) || cfg.registerTimeoutMs < 100) { console.error('moch-relay-server: --register-timeout-ms must be >= 100'); process.exit(2) }
if (!Number.isInteger(cfg.verifyTimeoutMs) || cfg.verifyTimeoutMs < 100) { console.error('moch-relay-server: --verify-timeout-ms must be >= 100'); process.exit(2) }
if (cfg.requireKey && cfg.openRegistration) { console.error('moch-relay-server: --open-registration conflicts with --require-key'); process.exit(2) }
if (!cfg.state) cfg.state = path.join(process.env.HOME || '.', '.moch', 'relay', 'state.json')

const TUNNEL_TIMEOUT_MS = 15_000        // phone waits this long for the machine's tunnel leg
const HEARTBEAT_MS = 20_000             // ping every 20s on /control; drop after 2 missed pongs
const MAX_PRETUNNEL_BYTES = 128 * 1024  // phone bytes buffered while the tunnel leg is pending
const MAX_TUNNEL_PAYLOAD = 2 * 1024 * 1024
const MAX_CONTROL_PAYLOAD = 4096
const MAX_UNREGISTERED_PER_IP = 5       // parked (never-registering) /control sockets per source IP
const MAX_UNREGISTERED_TOTAL = 100      // ... and globally

const log = (...m) => console.log(new Date().toISOString(), ...m)
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const timingSafeHexEq = (a, b) => {
  const A = Buffer.from(String(a), 'utf8')
  const B = Buffer.from(String(b), 'utf8')
  return A.length === B.length && crypto.timingSafeEqual(A, B)
}

// Plain-text HTTP error on a not-yet-upgraded socket, then hang up.
function httpErr(sock, code, text) {
  if (!sock || sock.destroyed) return
  const reason = http.STATUS_CODES[code] || 'Error'
  const body = String(text)
  try {
    sock.end(
      `HTTP/1.1 ${code} ${reason}\r\n` +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' + body)
  } catch { try { sock.destroy() } catch {} }
}

// ---- machine registry (persistent) ----------------------------------------------
//
// machines: Map<machineId, { id, tokenHash, ip, registeredAt, lastSeen,
//                            ctl: WebSocket|null, hb: interval|null,
//                            pending: Set<connId> }>

const machines = new Map()
const conns = new Map() // connId -> { id, machine, phone, tunnel, buf[], bufLen, timer, inB, outB }
// Proof-of-possession challenges for pending registrations:
//   nonce -> { ws, id, tokenHash, msg, ip, timer }
const pendingVerifies = new Map()
let stateHardenedLogged = false
// Parked (opened but never registered) /control sockets, for the idle caps.
let unregisteredTotal = 0
const unregisteredByIp = new Map()

function findByHash(tokenHash) {
  for (const m of machines.values()) if (m.tokenHash === tokenHash) return m
  return null
}
function onlineMachineByHash(tokenHash) {
  const m = findByHash(tokenHash)
  return m && m.ctl && m.ctl.readyState === WS.OPEN ? m : null
}
function onlineCount() {
  let n = 0
  for (const m of machines.values()) if (m.ctl) n++
  return n
}

function loadState() {
  let doc = null
  try { doc = JSON.parse(fs.readFileSync(cfg.state, 'utf8')) } catch { return }
  const list = doc && Array.isArray(doc.machines) ? doc.machines : []
  for (const it of list) {
    if (!it || typeof it.id !== 'string' || !/^[0-9a-f]{64}$/.test(String(it.tokenHash || ''))) continue
    if (machines.has(it.id) || findByHash(it.tokenHash)) { log('state: dropping duplicate entry for machine', it.id); continue }
    machines.set(it.id, {
      id: it.id, tokenHash: it.tokenHash, ip: typeof it.ip === 'string' ? it.ip : '',
      registeredAt: it.registeredAt || '', lastSeen: it.lastSeen || '',
      ctl: null, hb: null, pending: new Set(),
    })
  }
  if (machines.size) log('state: loaded', machines.size, 'machine registration(s) from', cfg.state)
}

function saveState() {
  const doc = {
    version: 1,
    machines: [...machines.values()].map((m) => ({
      id: m.id, tokenHash: m.tokenHash, ip: m.ip,
      registeredAt: m.registeredAt, lastSeen: m.lastSeen, online: !!m.ctl,
    })),
  }
  try {
    // state.json is the credential store (token hashes route every phone
    // dial) — 0700 dir / 0600 file, and chmod after the write because the
    // writeFileSync mode only applies at file creation (the .tmp from a
    // previous run keeps its old mode otherwise).
    fs.mkdirSync(path.dirname(cfg.state), { recursive: true, mode: 0o700 })
    const tmp = cfg.state + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch { /* best effort on exotic fs */ }
    fs.renameSync(tmp, cfg.state) // atomic on POSIX
    if (!stateHardenedLogged) {
      stateHardenedLogged = true
      log('state: hardening on —', cfg.state, 'is written mode 0600 in a 0700 dir (token hashes are the only credential)')
    }
  } catch (e) { log('state: save failed:', e.message) }
}

// ---- /control — machine registration + conn requests -----------------------------

const controlWss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_PAYLOAD })

function rejectRegister(ws, reason) {
  log('register refused:', reason)
  try { ws.send(JSON.stringify({ t: 'error', error: reason })) } catch {}
  try { ws.close(4000, reason) } catch {}
}

// Parked (opened, not yet registered) /control sockets — caps: 5 per source
// IP, 100 global. Real tunnels send their register the moment the socket
// opens, so nobody legitimate ever waits long enough to feel these.
function parkControlSocket(ws, ip) {
  const n = unregisteredByIp.get(ip) || 0
  if (unregisteredTotal >= MAX_UNREGISTERED_TOTAL || n >= MAX_UNREGISTERED_PER_IP) {
    log('control socket from', ip, 'refused — parked-socket cap reached (global', unregisteredTotal + ', this ip', n + ')')
    try { ws.close(4002, 'too many waiting control sockets') } catch {}
    return false
  }
  unregisteredTotal++
  unregisteredByIp.set(ip, n + 1)
  ws.__parked = true
  return true
}
function releaseControlSocket(ws) {
  if (!ws.__parked) return
  ws.__parked = false
  unregisteredTotal = Math.max(0, unregisteredTotal - 1)
  const n = (unregisteredByIp.get(ws.__ip) || 1) - 1
  if (n > 0) unregisteredByIp.set(ws.__ip, n)
  else unregisteredByIp.delete(ws.__ip)
}

// Proof-of-possession: this register would CREATE a credential or TAKE OVER
// a hash. sha256 alone is not evidence the dialer holds the raw token —
// anyone who saw the hash (or guesses it) must instead open /tunnel/<nonce>
// keyed with the raw token within the verify window. Only then is the
// registration committed.
function beginVerify(ws, id, tokenHash, ip) {
  for (const [n, pv] of pendingVerifies) {
    if (pv.ws === ws) { clearTimeout(pv.timer); pendingVerifies.delete(n) } // re-register replaced it
  }
  const nonce = crypto.randomBytes(16).toString('hex')
  const entry = { ws, id, tokenHash, ip, timer: null }
  entry.timer = setTimeout(() => {
    if (pendingVerifies.get(nonce) !== entry) return
    pendingVerifies.delete(nonce)
    log('register verify FAILED — machine', id, 'from', ip, 'showed no proof of the raw token within', cfg.verifyTimeoutMs + 'ms')
    try { ws.close(4003, 'verify failed') } catch {}
  }, cfg.verifyTimeoutMs)
  pendingVerifies.set(nonce, entry)
  log('machine', id, 'from', ip, '— verify challenge issued (nonce', nonce.slice(0, 8) + '…): open /tunnel/<nonce> with the raw token within', Math.round(cfg.verifyTimeoutMs / 1000) + 's')
  try { ws.send(JSON.stringify({ t: 'verify', nonce })) } catch (e) {
    clearTimeout(entry.timer)
    pendingVerifies.delete(nonce)
  }
}

// Commit a shape- and key-validated registration (directly for a known
// returning (id, tokenHash) pair, or after a discharged verify challenge).
function commitRegister(ws, id, tokenHash, ip) {
  const twin = findByHash(tokenHash)
  if (twin && twin.id !== id) {
    // The token IS the identity. A reinstall (or new machine) presenting the
    // same token may re-pair it — but only AFTER proving possession of the
    // raw token (beginVerify ran before we got here), and only while the
    // current holder is offline: refusing a live holder is what keeps a
    // stolen hash from evicting a healthy machine.
    if (twin.ctl && twin.ctl.readyState === WS.OPEN) {
      log('register refused: duplicate tokenHash', tokenHash.slice(0, 10), 'from machine', id, '(live holder:', twin.id + ')')
      return rejectRegister(ws, 'duplicate tokenHash: token already in use by a live machine')
    }
    log('machine', id, 're-pairing token hash from offline machine', twin.id, '(possession proven)')
    machines.delete(twin.id)
    saveState()
  }
  let m = machines.get(id)
  if (m && m.ctl === ws) { // duplicate register on the same socket: just re-ack
    try { ws.send(JSON.stringify({ t: 'registered', host: cfg.host })) } catch {}
    return
  }
  if (!m) {
    const sameIp = [...machines.values()].filter((x) => x.ip === ip)
    if (sameIp.length >= cfg.maxMachinesPerIp) {
      // Offline slots must not wall out a returning machine (seen live: three
      // dead test registrations blocked everyone). The cap means CONCURRENT
      // machines per IP — evict the oldest offline one to make room; reject
      // only when the IP truly holds max live machines.
      const dead = sameIp
        .filter((x) => !x.ctl || x.ctl.readyState !== WS.OPEN)
        .sort((a, b) => String(a.lastSeen || a.registeredAt).localeCompare(String(b.lastSeen || b.registeredAt)))
      if (sameIp.length - dead.length >= cfg.maxMachinesPerIp || dead.length === 0) {
        return rejectRegister(ws, `machine limit reached for this IP (max ${cfg.maxMachinesPerIp})`)
      }
      const victim = dead[0]
      machines.delete(victim.id)
      saveState()
      log('evicted offline machine', victim.id, 'from', ip, 'to free a slot')
    }
    m = { id, tokenHash, ip, registeredAt: new Date().toISOString(), lastSeen: '', ctl: null, hb: null, pending: new Set() }
    machines.set(id, m)
  }
  const wasOnline = !!m.ctl && m.ctl !== ws
  if (m.ctl && m.ctl !== ws) { log('machine', id, 're-registered — dropping previous control socket'); try { m.ctl.terminate() } catch {} }
  if (m.tokenHash !== tokenHash) { log('machine', id, 're-paired with a new token hash (possession proven)'); m.tokenHash = tokenHash }
  m.ip = ip
  m.ctl = ws
  m.__alive = true

  m.hb = setInterval(() => {
    if (m.ctl !== ws || ws.readyState !== WS.OPEN) return
    if (m.__alive === false) { log('machine', id, 'missed heartbeats — dropping control socket'); try { ws.terminate() } catch {}; return }
    m.__alive = false
    try { ws.ping() } catch {}
  }, HEARTBEAT_MS)

  const bye = () => {
    clearInterval(m.hb)
    if (machines.get(id) !== m || m.ctl !== ws) return // superseded by a newer socket
    m.ctl = null
    m.lastSeen = new Date().toISOString()
    saveState()
    log('machine', id, 'offline (registration kept)')
    for (const cid of [...m.pending]) {
      const c = conns.get(cid)
      if (!c) { m.pending.delete(cid); continue }
      httpErr(c.phone, 502, 'machine went offline')
      dropConn(cid)
    }
  }
  ws.on('pong', () => { m.__alive = true })
  ws.on('close', bye)
  ws.on('error', (e) => { log('control socket error for', id + ':', e.message); bye() })

  saveState()
  try { ws.send(JSON.stringify({ t: 'registered', host: cfg.host })) } catch { return }
  log('machine', id, 'online from', ip, wasOnline ? '(re-registered)' : '(new)')
}

function handleRegister(ws, msg, ip) {
  const id = typeof msg.machine === 'string' ? msg.machine : ''
  const tokenHash = typeof msg.tokenHash === 'string' ? msg.tokenHash.toLowerCase() : ''
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return rejectRegister(ws, 'invalid machine id')
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return rejectRegister(ws, 'invalid tokenHash (need hex sha256)')
  if (cfg.requireKey) {
    const given = typeof msg.key === 'string' ? sha256hex(msg.key) : ''
    if (!given || !timingSafeHexEq(given, sha256hex(cfg.requireKey))) return rejectRegister(ws, 'invalid relay key')
  }
  // Returning machines whose exact (id, tokenHash) pair is already in the
  // registry keep the hash-only register (reconnect path unchanged). Every
  // other register — brand-new machine id, a known id switching hashes, or a
  // hash whose twin is offline — must prove possession of the raw token.
  const known = machines.get(id)
  if (known && known.tokenHash === tokenHash) return commitRegister(ws, id, tokenHash, ip)
  if (ws.readyState !== WS.OPEN) return
  beginVerify(ws, id, tokenHash, ip)
}

controlWss.on('connection', (ws, req) => {
  // Behind a reverse proxy (nginx) every direct socket is loopback. Trust
  // X-Forwarded-For ONLY when the socket really is loopback — and then only
  // the LAST entry: nginx APPENDS the real client to whatever the client
  // itself sent, so the last hop is the one our proxy vouches for. The first
  // entry is client-controlled and was trivially spoofable.
  let ip = (req && req.socket && req.socket.remoteAddress) || 'unknown'
  const socketAddr = ip
  if (/^(127\.|::1|::ffff:127\.)/.test(socketAddr)) {
    const xff = req && req.headers && req.headers['x-forwarded-for']
    const last = typeof xff === 'string' ? xff.split(',').pop().trim() : ''
    if (last) ip = last
  }
  ws.__ip = ip
  if (!parkControlSocket(ws, ip)) return
  // Real tunnels register the instant the socket opens (install.sh sends the
  // register message in the 'open' handler). A /control socket that never
  // registers is parked dead weight — close it.
  ws.__regTimer = setTimeout(() => {
    log('control socket from', ip, 'never registered — closing (register timeout)')
    try { ws.close(4001, 'register timeout') } catch {}
  }, cfg.registerTimeoutMs)
  ws.on('close', () => {
    if (ws.__regTimer) { clearTimeout(ws.__regTimer); ws.__regTimer = null }
    releaseControlSocket(ws)
    for (const [n, pv] of [...pendingVerifies]) {
      if (pv.ws === ws) { clearTimeout(pv.timer); pendingVerifies.delete(n) }
    }
  })
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString('utf8')) } catch { try { ws.close(1002, 'bad json') } catch {}; return }
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'register') {
      // A register message arrived: the socket is no longer idle-parked
      // (verify challenges own their own failure path via 4003).
      if (ws.__regTimer) { clearTimeout(ws.__regTimer); ws.__regTimer = null }
      releaseControlSocket(ws)
      handleRegister(ws, msg, ip)
      return
    }
    // After registration the machine only needs to listen; unknown types are ignored.
  })
})

// ---- /api/ws — phone entry, raw splice (no handshake of our own) ------------------

function reconstructHead(req, target) {
  // The phone's upgrade request exactly as the home gateway must see it:
  // request line + original header order/casing. `target` is the request
  // target to forward — req.url verbatim, except for header-auth dials where
  // phoneEntry appends the query the home's WS gate expects (below).
  let out = `${req.method} ${target} HTTP/${req.httpVersion}\r\n`
  for (let i = 0; i < req.rawHeaders.length; i += 2) out += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
  return Buffer.from(out + '\r\n')
}

function phoneEntry(req, socket, head) {
  let url
  try { url = new URL(req.url, 'http://x') } catch { return httpErr(socket, 400, 'bad request') }
  // The phone's REST calls (media download/stream, file fetches, apiFetch)
  // carry the token in the X-Hermes-Session-Token header (or Bearer); the
  // WebSocket dial prefers the header too (?token= in the query is the
  // legacy form, still accepted). Both route by the same hash.
  const hdr = req.headers['x-hermes-session-token']
  const bearer = typeof req.headers['authorization'] === 'string'
    ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : ''
  const headerToken = (typeof hdr === 'string' && hdr ? hdr : '') || bearer
  const queryToken = url.searchParams.get('token')
  const token = queryToken || headerToken
  if (!token) return httpErr(socket, 401, 'missing token')
  const machine = onlineMachineByHash(sha256hex(token))
  if (!machine) return httpErr(socket, 401, 'unknown token or machine offline')
  if (machine.pending.size >= cfg.maxPending) return httpErr(socket, 503, 'machine busy (too many pending connections)')

  // Header-auth dial: the home's WebSocket gate reads ?token= off the
  // request line (and moch-link's push watcher greps the line for ?push=).
  // Rewrite the FORWARDED request line to append them — the values are
  // already in relay memory, and on the wire they ride only the tunnel leg
  // to the home, never a URL at the relay's own front door or an access
  // log there. Existing query parameters are preserved byte-for-byte.
  let target = req.url
  if (!queryToken && headerToken) {
    const pushHdr = typeof req.headers['x-hermes-push-token'] === 'string' ? req.headers['x-hermes-push-token'] : ''
    if (!url.searchParams.has('token')) target += (target.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(headerToken)
    if (pushHdr && !url.searchParams.has('push')) target += (target.includes('?') ? '&' : '?') + 'push=' + encodeURIComponent(pushHdr)
  }

  const id = crypto.randomUUID()
  const buf = [reconstructHead(req, target)]
  if (head && head.length) buf.push(head)
  const conn = {
    id, machine, phone: socket, tunnel: null, buf, bufLen: buf.reduce((n, b) => n + b.length, 0),
    timer: null, inB: 0, outB: 0,
  }
  conns.set(id, conn)
  machine.pending.add(id)
  socket.pause() // hold the phone still until the tunnel leg arrives; bytes buffer bounded

  conn.timer = setTimeout(() => {
    log('conn', id.slice(0, 8), 'tunnel request timed out after', TUNNEL_TIMEOUT_MS + 'ms')
    httpErr(socket, 504, 'tunnel timeout')
    dropConn(id)
  }, TUNNEL_TIMEOUT_MS)

  socket.on('data', (chunk) => onPhoneData(conn, chunk))
  socket.on('close', () => onPhoneGone(id))
  socket.on('end', () => onPhoneGone(id)) // FIN half-close: the phone is gone, don't park the conn
  socket.on('error', (e) => { log('conn', id.slice(0, 8), 'phone socket error:', e.message); onPhoneGone(id) })

  try { machine.ctl.send(JSON.stringify({ t: 'conn', id })) } catch (e) {
    httpErr(socket, 502, 'machine control socket lost')
    return dropConn(id)
  }
  log('conn', id.slice(0, 8), 'phone -> machine', machine.id)
}

function onPhoneData(conn, chunk) {
  if (!conns.has(conn.id)) return
  if (!conn.tunnel) {
    conn.buf.push(chunk)
    conn.bufLen += chunk.length
    if (conn.bufLen > MAX_PRETUNNEL_BYTES) {
      log('conn', conn.id.slice(0, 8), 'pre-tunnel buffer overflow — dropping')
      httpErr(conn.phone, 413, 'request too large')
      dropConn(conn.id)
    }
    return
  }
  conn.inB += chunk.length
  if (conn.tunnel.readyState !== WS.OPEN) return dropConn(conn.id)
  conn.phone.pause() // one chunk in flight; backpressure instead of buffering
  conn.tunnel.send(chunk, { binary: true }, () => { if (!conn.phone.destroyed) conn.phone.resume() })
}

function onPhoneGone(id) {
  const c = conns.get(id)
  if (!c) return
  log('conn', id.slice(0, 8), 'phone disconnected')
  dropConn(id)
}

// ---- /tunnel/<id> — machine leg for one phone conn --------------------------------

const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: MAX_TUNNEL_PAYLOAD })

function tunnelEntry(req, socket, head, url) {
  let id = ''
  try { id = decodeURIComponent(url.pathname.slice('/tunnel/'.length)) } catch { return httpErr(socket, 400, 'bad tunnel id') }
  // Key transport: X-Moch-Tunnel-Key header preferred; ?key= in the query is
  // the legacy form (URLs land in proxy access logs — headers don't).
  const key = url.searchParams.get('key')
    || (typeof req.headers['x-moch-tunnel-key'] === 'string' ? req.headers['x-moch-tunnel-key'] : '')
    || ''

  // Verify leg: /tunnel/<nonce> discharges a pending registration's
  // proof-of-possession challenge. sha256(rawToken) === tokenHash is the
  // proof; wrong keys just 403 and may retry inside the window.
  const pv = pendingVerifies.get(id)
  if (pv) {
    if (!timingSafeHexEq(sha256hex(key), pv.tokenHash)) return httpErr(socket, 403, 'bad machine key')
    return tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      if (pendingVerifies.get(id) !== pv) { try { ws.close(1011, 'verify gone') } catch {}; return }
      clearTimeout(pv.timer)
      pendingVerifies.delete(id)
      log('register verify PASSED — machine', pv.id, 'proved possession of the token')
      try { ws.close(1000, 'verified') } catch {}
      if (pv.ws.readyState !== WS.OPEN) { log('register verify wasted — control socket for', pv.id, 'already gone'); return }
      commitRegister(pv.ws, pv.id, pv.tokenHash, pv.ip)
    })
  }

  const conn = conns.get(id)
  if (!conn) return httpErr(socket, 410, 'unknown connection id')
  if (conn.tunnel) return httpErr(socket, 410, 'connection already established')
  if (!timingSafeHexEq(sha256hex(key), conn.machine.tokenHash)) return httpErr(socket, 403, 'bad machine key')

  tunnelWss.handleUpgrade(req, socket, head, (ws) => {
    if (!conns.has(id) || conn.tunnel) { try { ws.close(1011, 'conn gone') } catch {}; return }
    clearTimeout(conn.timer)
    conn.machine.pending.delete(id)
    conn.tunnel = ws

    const buffered = Buffer.concat(conn.buf)
    conn.buf = []
    conn.bufLen = 0
    if (buffered.length && ws.readyState === WS.OPEN) ws.send(buffered, { binary: true }) // the phone's untouched handshake goes home first
    conn.phone.resume()

    ws.on('message', (data) => {
      if (conn.phone.destroyed) return
      conn.outB += data.length
      const ok = conn.phone.write(data)
      if (!ok && ws._socket) ws._socket.pause()
    })
    conn.phone.on('drain', () => { if (conn.tunnel && conn.tunnel._socket) conn.tunnel._socket.resume() })

    const done = () => {
      if (!conns.has(id)) return
      log('conn', id.slice(0, 8), 'closed (' + conn.inB + 'b phone->home, ' + conn.outB + 'b home->phone)')
      dropConn(id)
    }
    ws.on('close', done)
    ws.on('error', (e) => { log('conn', id.slice(0, 8), 'tunnel leg error:', e.message); done() })

    log('conn', id.slice(0, 8), 'spliced (' + buffered.length + 'b handshake forwarded)')
  })
}

function dropConn(id) {
  const c = conns.get(id)
  if (!c) return
  conns.delete(id)
  clearTimeout(c.timer)
  c.machine.pending.delete(id)
  if (!c.tunnel && c.machine.ctl && c.machine.ctl.readyState === WS.OPEN) {
    try { c.machine.ctl.send(JSON.stringify({ t: 'cancel', id })) } catch {} // phone gave up before the leg arrived
  }
  if (c.tunnel) { try { c.tunnel.terminate() } catch {} }
  if (!c.phone.destroyed) c.phone.destroy()
}

// ---- HTTP server -------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let url
  try { url = new URL(req.url, 'http://x') } catch { res.writeHead(400); return res.end('bad request') }
  if (url.pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    // {"ok":true} stays unauthenticated for anyone's uptime probe; the
    // machine/connection counts are operational detail behind the relay key
    // (?key= or X-Moch-Relay-Key) when one is configured, omitted otherwise.
    let keyed = false
    if (cfg.requireKey) {
      const given = url.searchParams.get('key')
        || (typeof req.headers['x-moch-relay-key'] === 'string' ? req.headers['x-moch-relay-key'] : '')
        || ''
      keyed = !!given && timingSafeHexEq(sha256hex(given), sha256hex(cfg.requireKey))
    }
    const body = keyed ? { ok: true, machines: onlineCount(), connections: conns.size } : { ok: true }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/ws') { res.writeHead(426, { 'Content-Type': 'text/plain' }); return res.end('websocket upgrade required') }
  // Plain-HTTP /api/* rides the SAME token-routed splice as the WebSocket:
  // media downloads, file streams and the app's REST calls would otherwise
  // 404 at the relay while chat works — the "image shows but the viewer is
  // blank / audio won't play" failure. Node's parser consumes the request
  // (and any body) off the socket before we hijack it, so the head is
  // rebuilt and the body buffered, then the whole thing rides the tunnel
  // leg; the backend's response flows back as raw bytes on the same socket.
  if (url.pathname.startsWith('/api/')) {
    const socket = res.socket
    const chunks = []
    let bodyLen = 0
    req.on('data', (c) => {
      bodyLen += c.length
      if (bodyLen > MAX_TUNNEL_PAYLOAD) { try { socket.destroy() } catch {} ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { res.detachSocket(socket) } catch { /* nothing to detach */ }
      phoneEntry(req, socket, Buffer.concat(chunks))
    })
    req.on('error', () => { try { socket.destroy() } catch {} })
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})
server.on('clientError', (err, socket) => {
  if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
})
server.on('upgrade', (req, socket, head) => {
  let url
  try { url = new URL(req.url, 'http://x') } catch { return httpErr(socket, 400, 'bad request') }
  if (url.pathname === '/control') {
    return controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req))
  }
  if (url.pathname === '/api/ws') return phoneEntry(req, socket, head)
  if (url.pathname.startsWith('/tunnel/')) return tunnelEntry(req, socket, head, url)
  httpErr(socket, 404, 'not found')
})

// ---- lifecycle ----------------------------------------------------------------------

process.on('uncaughtException', (e) => log('uncaught exception (continuing):', e && e.stack || e))
process.on('unhandledRejection', (e) => log('unhandled rejection (continuing):', e && (e.stack || e.message) || e))

function shutdown(sig) {
  log('shutdown on', sig, '— closing', conns.size, 'conn(s),', onlineCount(), 'online machine(s)')
  for (const id of [...conns.keys()]) dropConn(id)
  for (const m of machines.values()) {
    clearInterval(m.hb)
    if (m.ctl) { try { m.ctl.close(1001, 'relay shutting down') } catch {} }
  }
  saveState()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref() // don't wait for stragglers forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

loadState()
if (cfg.bind) {
  server.listen(cfg.port, cfg.bind, onListening)
} else {
  server.listen(cfg.port, onListening) // all interfaces (previous default)
}
function onListening() {
  log('moch-relay-server listening on', (cfg.bind || '0.0.0.0') + ':' + cfg.port, '(plain http/ws — put a TLS terminator in front)')
  log('public endpoint base wss://' + cfg.host + ' (acks report this host); state:', cfg.state)
  log('limits: max-machines-per-ip', cfg.maxMachinesPerIp + ', max-pending', cfg.maxPending + ', tunnel-timeout 15s, heartbeat 20s, register-timeout', Math.round(cfg.registerTimeoutMs / 1000) + 's, verify-timeout', Math.round(cfg.verifyTimeoutMs / 1000) + 's, require-key', cfg.requireKey ? 'ON' : 'off (open registration)')
  if (!cfg.requireKey && !cfg.openRegistration) {
    log(
      'DEPRECATION ─────────────────────────────────────────────────────────────\n' +
      '  OPEN REGISTRATION is enabled: no --require-key is set, so ANYONE who\n' +
      '  can reach this relay can register a machine against it. Open\n' +
      '  registration is DEPRECATED and will require a key in a future release.\n' +
      '  Switch now:    --require-key <key>   (and pass --relay-key <key> to\n' +
      '                                       moch-link / moch-tunnel installs)\n' +
      '  Or opt in:     --open-registration   (run open anyway; silences this)\n' +
      '──────────────────────────────────────────────────────────────────────────')
  } else if (!cfg.requireKey && cfg.openRegistration) {
    log('open registration: explicitly opted in via --open-registration (deprecated — a key will be required in a future release)')
  }
}
