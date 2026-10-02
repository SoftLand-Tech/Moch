#!/usr/bin/env node
// moch-relay-server — the official Moch relay service.
//
//   phone                 relay (this file)              home machine (moch-tunnel.js)
//   --ws /api/ws?token=T-->  sha256(T) -> machine   --{"t":"conn","id"}--> /control ws
//                           phone socket parked      <--ws /tunnel/<id>?key=token--
//                           RAW byte splice phone socket <-> tunnel socket
//
// The phone's WebSocket handshake — token included — is reconstructed verbatim
// from its original request line/headers and reaches the home gateway
// untouched; the home gateway does the real 401/101. The relay never sees the
// pairing token, only its sha256.
//
// Endpoints (single port, behind a TLS terminator in production — the public
// base is wss://api.moch.softland.tech:443; plain ws://host:<port> for tests):
//   GET  /health                 -> {"ok":true,"machines":<online>,"connections":<open phone legs>}
//   ws   /control                machine -> service. Register:
//        {"t":"register","machine":<id>,"tokenHash":<hex sha256 of gateway pairing token>}
//        (add "key":<relay-key> when the service runs --require-key)
//        Service acks {"t":"registered","host":<public host>}. Machine stays
//        'online' while the socket lives; offline on close (registration kept).
//        Service -> machine: {"t":"conn","id":<uuid>}, {"t":"cancel","id":<uuid>}.
//   ws   /api/ws?token=<token>   phone -> service. No handshake of our own:
//        unknown hash or offline machine -> 401 before upgrade; else the
//        machine has 15s to open the tunnel leg, then raw splice.
//   ws   /tunnel/<connId>?key=<machine secret>
//        machine -> service. The machine secret is the raw gateway pairing
//        token — the service proves it by sha256(key) === registered tokenHash.
//
// Registration is open by default with limits (max 3 machines per source IP,
// max 20 pending phone conns per machine, 15s tunnel-request timeout);
// --require-key switches registration to a shared relay key. Machines persist
// in a JSON state file (in-memory map + atomic tmp/rename writes).
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
    '                         [--state <file>] [--require-key <key>]\n' +
    '                         [--max-machines-per-ip 20] [--max-pending 200]')
  process.exit(code)
}

function parseArgs(argv) {
  const out = {
    port: 9591,
    host: 'api.moch.softland.tech',
    state: '',
    requireKey: '',
    maxMachinesPerIp: 20,   // whole households/campuses share one NAT IP — cap abuse, not families
    maxPending: 200,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) usage(2)
      return argv[++i]
    }
    if (a === '--port') out.port = Number(next())
    else if (a === '--host') out.host = String(next())
    else if (a === '--state') out.state = String(next())
    else if (a === '--require-key') out.requireKey = String(next())
    else if (a === '--max-machines-per-ip') out.maxMachinesPerIp = Number(next())
    else if (a === '--max-pending') out.maxPending = Number(next())
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
if (!cfg.state) cfg.state = path.join(process.env.HOME || '.', '.moch', 'relay', 'state.json')

const TUNNEL_TIMEOUT_MS = 15_000        // phone waits this long for the machine's tunnel leg
const HEARTBEAT_MS = 20_000             // ping every 20s on /control; drop after 2 missed pongs
const MAX_PRETUNNEL_BYTES = 128 * 1024  // phone bytes buffered while the tunnel leg is pending
const MAX_TUNNEL_PAYLOAD = 2 * 1024 * 1024
const MAX_CONTROL_PAYLOAD = 4096

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
    fs.mkdirSync(path.dirname(cfg.state), { recursive: true })
    const tmp = cfg.state + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n')
    fs.renameSync(tmp, cfg.state) // atomic on POSIX
  } catch (e) { log('state: save failed:', e.message) }
}

// ---- /control — machine registration + conn requests -----------------------------

const controlWss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_PAYLOAD })

function rejectRegister(ws, reason) {
  log('register refused:', reason)
  try { ws.send(JSON.stringify({ t: 'error', error: reason })) } catch {}
  try { ws.close(4000, reason) } catch {}
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
  const twin = findByHash(tokenHash)
  if (twin && twin.id !== id) {
    // The token IS the identity. A reinstall (or new machine) presenting the
    // same token may re-pair it, unless the current holder is live — refusing
    // here would permanently strand a token whose machine file was wiped.
    if (twin.ctl && twin.ctl.readyState === WS.OPEN) {
      log('register refused: duplicate tokenHash', tokenHash.slice(0, 10), 'from machine', id, '(live holder:', twin.id + ')')
      return rejectRegister(ws, 'duplicate tokenHash: token already in use by a live machine')
    }
    log('machine', id, 're-pairing token hash from offline machine', twin.id)
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
  if (m.tokenHash !== tokenHash) { log('machine', id, 're-paired with a new token hash'); m.tokenHash = tokenHash }
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

controlWss.on('connection', (ws, req) => {
  // Behind a reverse proxy (nginx) every direct socket is loopback and the
  // per-IP machine limit would key the whole world as one IP. Trust
  // X-Forwarded-For ONLY when the socket really is loopback — direct
  // exposure keeps using the socket address, unspoofable.
  let ip = (req && req.socket && req.socket.remoteAddress) || 'unknown'
  const socketAddr = ip
  if (/^(127\.|::1|::ffff:127\.)/.test(socketAddr)) {
    const xff = req && req.headers && req.headers['x-forwarded-for']
    const first = typeof xff === 'string' ? xff.split(',')[0].trim() : ''
    if (first) ip = first
  }
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString('utf8')) } catch { try { ws.close(1002, 'bad json') } catch {}; return }
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'register') { handleRegister(ws, msg, ip); return }
    // After registration the machine only needs to listen; unknown types are ignored.
  })
})

// ---- /api/ws — phone entry, raw splice (no handshake of our own) ------------------

function reconstructHead(req) {
  // The phone's upgrade request exactly as the home gateway must see it:
  // original request line (token in the query) + original header order/casing.
  let out = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
  for (let i = 0; i < req.rawHeaders.length; i += 2) out += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
  return Buffer.from(out + '\r\n')
}

function phoneEntry(req, socket, head) {
  let url
  try { url = new URL(req.url, 'http://x') } catch { return httpErr(socket, 400, 'bad request') }
  const token = url.searchParams.get('token') || ''
  if (!token) return httpErr(socket, 401, 'missing token')
  const machine = onlineMachineByHash(sha256hex(token))
  if (!machine) return httpErr(socket, 401, 'unknown token or machine offline')
  if (machine.pending.size >= cfg.maxPending) return httpErr(socket, 503, 'machine busy (too many pending connections)')

  const id = crypto.randomUUID()
  const buf = [reconstructHead(req)]
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
  const key = url.searchParams.get('key') || ''
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
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, machines: onlineCount(), connections: conns.size }))
  }
  if (url.pathname === '/api/ws') { res.writeHead(426, { 'Content-Type': 'text/plain' }); return res.end('websocket upgrade required') }
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
server.listen(cfg.port, () => {
  log('moch-relay-server listening on port', cfg.port, '(plain http/ws — put a TLS terminator in front)')
  log('public endpoint base wss://' + cfg.host + ' (acks report this host); state:', cfg.state)
  log('limits: max-machines-per-ip', cfg.maxMachinesPerIp + ', max-pending', cfg.maxPending + ', tunnel-timeout 15s, heartbeat 20s, require-key', cfg.requireKey ? 'ON' : 'off (open registration)')
})
