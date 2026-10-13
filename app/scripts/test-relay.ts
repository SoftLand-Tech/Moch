// Integration tests for the hardened Moch relay (relay/moch-relay-server.js)
// — the security claims of audit C-01/C-02/C-03, exercised against the REAL
// server as a child process on an ephemeral port with an isolated HOME (own
// state.json). Same constraints as the other script suites: plain node via
// tsx, no RN, no device.
//
// Covered:
//   (a) fresh registration completes the proof-of-possession verify leg
//   (b) a NEW machine registering an existing (offline twin's) hash FAILS
//       without proof (closed 4003, twin keeps the slot)      [C-01]
//   (c) the same (id, tokenHash) reconnecting needs NO challenge [C-01]
//   (d) a never-registering /control socket is closed 4001      [C-03]
//   (e) /health without the relay key omits machine counts; the key unlocks
//       them                                                    [C-03]
//   (f) a header-auth phone dial routes to the machine and the forwarded
//       request line carries ?token=&push=                      [C-02]
//   (g) parked-socket caps: the 6th unregistered /control socket from one IP
//       is refused 4002                                         [C-03]
//   + state.json is written 0600 inside a 0700 dir              [C-01]
export {}
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import WS from 'ws'

const RELAY_JS = path.join(__dirname, '..', '..', 'relay', 'moch-relay-server.js')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

class Relay {
  proc: ChildProcess
  port: number
  home: string
  statePath: string
  private lines: string[] = []

  private constructor(proc: ChildProcess, port: number, home: string) {
    this.proc = proc
    this.port = port
    this.home = home
    this.statePath = path.join(home, '.moch', 'relay', 'state.json')
  }

  static async start(opts: { requireKey?: string } = {}): Promise<Relay> {
    const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'moch-relay-test-'))
    let lastErr = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      const port = 20000 + Math.floor(Math.random() * 20000)
      const args = [
        RELAY_JS, '--port', String(port), '--host', 'relay.test',
        '--register-timeout-ms', '1500', '--verify-timeout-ms', '4000',
      ]
      if (opts.requireKey) args.push('--require-key', opts.requireKey)
      const proc = spawn(process.execPath, args, {
        env: { ...process.env, HOME: home, NODE_PATH: path.join(__dirname, '..', 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const relay = new Relay(proc, port, home)
      const ok = await relay.waitForBoot(proc)
      if (ok) return relay
      lastErr = relay.lines.join('\n')
      try { proc.kill('SIGKILL') } catch { /* already gone */ }
      await fs.promises.rm(home, { recursive: true, force: true }).catch(() => {})
    }
    throw new Error(`relay failed to boot: ${lastErr}`)
  }

  private waitForBoot(proc: ChildProcess): Promise<boolean> {
    return new Promise((resolve) => {
      let booted = false
      const t = setTimeout(() => { if (!booted) resolve(false) }, 4000)
      const onData = (d: Buffer) => {
        const s = d.toString('utf8')
        for (const line of s.split('\n')) this.lines.push(line)
        if (/listening on /.test(s) && proc.exitCode === null) {
          booted = true
          clearTimeout(t)
          resolve(true)
        }
      }
      proc.stdout!.on('data', onData)
      proc.stderr!.on('data', onData)
      proc.on('exit', () => { if (!booted) { clearTimeout(t); resolve(false) } })
    })
  }

  url(p: string): string { return `ws://127.0.0.1:${this.port}${p}` }
  httpBase(): string { return `http://127.0.0.1:${this.port}` }

  async stop(): Promise<void> {
    this.proc.kill('SIGKILL')
    await sleep(50)
    await fs.promises.rm(this.home, { recursive: true, force: true }).catch(() => {})
  }
}

interface ControlHandle {
  ws: WS
  messages: Array<Record<string, unknown>>
  nextMessage(t: string, timeoutMs?: number): Promise<Record<string, unknown> | null>
  close(): void
}

function openControl(relay: Relay, extraHeaders?: Record<string, string>): Promise<ControlHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WS(relay.url('/control'), { headers: extraHeaders, maxPayload: 64 * 1024 })
    ;(ws).on('error', () => {})  // harness: server-side closes/SIGKILL teardown must not crash the runner
    const messages: Array<Record<string, unknown>> = []
    const handle: ControlHandle = {
      ws,
      messages,
      nextMessage: (t: string, timeoutMs = 3000) => {
        const deadline = Date.now() + timeoutMs
        return new Promise((res) => {
          const poll = () => {
            const found = messages.find((m) => m.t === t && !(m as never as { __consumed?: boolean }).__consumed)
            if (found) { (found as never as { __consumed?: boolean }).__consumed = true; return res(found) }
            if (Date.now() > deadline) return res(null)
            setTimeout(poll, 30)
          }
          poll()
        })
      },
      close: () => { try { ws.close() } catch { /* gone */ } },
    }
    ws.on('message', (raw: WS.RawData) => {
      try { messages.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>) } catch { /* ignore */ }
    })
    let handleOpened = false
    ws.on('open', () => { handleOpened = true; resolve(handle) })
    ws.on('error', (e: Error) => { if (!handleOpened) reject(e) })
  })
}

/** Wait for the socket to close; resolves {code, reason}. */
function waitClose(ws: WS, timeoutMs = 8000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('socket did not close in time')), timeoutMs)
    ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(t)
      resolve({ code, reason: reason.toString('utf8') })
    })
    ws.on('error', (e: Error) => { clearTimeout(t); reject(e) })
  })
}

/** Register a machine the way the real moch-tunnel does — including the
 *  proof-of-possession verify leg when challenged. */
async function registerMachine(relay: Relay, machine: string, rawToken: string, opts: { proof?: boolean; relayKey?: string } = {}): Promise<{ ctl: ControlHandle; sawVerify: boolean }> {
  const ctl = await openControl(relay)
  const reg: Record<string, unknown> = { t: 'register', machine, tokenHash: sha256hex(rawToken) }
  if (opts.relayKey) reg.key = opts.relayKey
  ctl.ws.send(JSON.stringify(reg))
  const verify = await ctl.nextMessage('verify', 3000)
  if (!verify) {
    const ack = await ctl.nextMessage('registered', 1500)
    if (!ack) throw new Error(`${machine}: neither verify nor registered arrived`)
    return { ctl, sawVerify: false }
  }
  if (opts.proof === false) return { ctl, sawVerify: true } // deliberately withhold proof
  const nonce = String(verify.nonce)
  await new Promise<void>((resolve, reject) => {
    const leg = new WS(relay.url(`/tunnel/${encodeURIComponent(nonce)}`), { headers: { 'X-Moch-Tunnel-Key': rawToken } })
    ;(leg).on('error', () => {})  // harness: server-side closes/SIGKILL teardown must not crash the runner
    leg.on('open', () => resolve())
    leg.on('error', (e: Error) => reject(e))
  })
  const ack = await ctl.nextMessage('registered', 3000)
  if (!ack) throw new Error(`${machine}: no registered ack after verify leg`)
  return { ctl, sawVerify: true }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url)
  return (await r.json()) as Record<string, unknown>
}

async function main() {
  if (!fs.existsSync(RELAY_JS)) {
    console.error(`relay not found at ${RELAY_JS} — run from the app/ directory of a full checkout`)
    process.exit(1)
  }

  const relay = await Relay.start()
  try {
    const T1 = 'tok-machine-a-4f2c91'
    const T2 = 'tok-machine-b-77aa01'

    // ── (a) fresh register: verify challenge + proof + ack ─────────────────
    const a = await registerMachine(relay, 'machine-a', T1)
    check('(a) fresh registration challenges then acks after the verify leg', a.sawVerify)
    const ackAny = a.ctl.messages.find((m) => m.t === 'registered')
    check('(a) registered ack reports the public host', ackAny?.host === 'relay.test')

    // state file hardening (C-01)
    await sleep(100)
    const st = fs.statSync(relay.statePath)
    const stDir = fs.statSync(path.dirname(relay.statePath))
    check('state.json is mode 0600', (st.mode & 0o777) === 0o600, `got ${((st.mode & 0o777) >>> 0).toString(8)}`)
    check('state dir is mode 0700', (stDir.mode & 0o777) === 0o700, `got ${(stDir.mode & 0o777).toString(8)}`)

    // ── (c) same (id, tokenHash) reconnects with NO challenge ──────────────
    a.ctl.close()
    await sleep(150) // relay marks the machine offline (registration kept)
    const a2 = await registerMachine(relay, 'machine-a', T1)
    check('(c) returning (id, tokenHash) needs no verify challenge', !a2.sawVerify)

    // ── (f) header-auth phone dial routes + forwarded line carries token ───
    const knockP = a2.ctl.nextMessage('conn', 5000)
    const phone = new WS(relay.url('/api/ws'), {
      headers: { 'X-Hermes-Session-Token': T1, 'X-Hermes-Push-Token': 'ExponentPushToken[test123]' },
    })
    ;(phone).on('error', () => {})  // harness: server-side closes/SIGKILL teardown must not crash the runner
    const knock = await knockP
    check('(f) phone dial via header knocks the machine', !!knock && typeof knock.id === 'string')
    const connId = String(knock?.id ?? '')
    const forwardedLine: string = await new Promise((resolve, reject) => {
      const leg = new WS(relay.url(`/tunnel/${encodeURIComponent(connId)}`), { headers: { 'X-Moch-Tunnel-Key': T1 } })
      ;(leg).on('error', () => {})  // harness: server-side closes/SIGKILL teardown must not crash the runner
      leg.on('message', (data: WS.RawData) => {
        // The forwarded request line may arrive flagged binary OR text (the
        // ws lib marks Buffer sends per options) — match on content, not flag.
        const s = Buffer.from(data as ArrayBuffer).toString('latin1')
        if (s.startsWith('GET ') || s.startsWith('POST ')) resolve(s.slice(0, s.indexOf('\r\n')))
      })
      leg.on('error', (e: Error) => reject(e))
      setTimeout(() => reject(new Error('no forwarded request line on the tunnel leg')), 5000)
    })
    check('(f) forwarded request line has the token injected', forwardedLine.includes(`token=${T1}`), forwardedLine)
    check('(f) forwarded request line has the push token injected', forwardedLine.includes('push=ExponentPushToken%5Btest123%5D'), forwardedLine)
    check('(f) forwarded request line targets /api/ws', forwardedLine.startsWith('GET /api/ws'))
    try { phone.close() } catch { /* gone */ }

    // ── (b) new machine stealing an offline twin's hash FAILS without proof ─
    a2.ctl.close()
    await sleep(150) // machine-a offline; its hash stays in state.json
    const b = await registerMachine(relay, 'machine-b', T1, { proof: false })
    check('(b) hash takeover is challenged', b.sawVerify)
    const closed = await waitClose(b.ctl.ws, 6000)
    check('(b) missing proof closes the socket 4003', closed.code === 4003, `code ${closed.code} (${closed.reason})`)
    // the twin was NOT evicted: machine-a still reconnects challenge-free
    const a3 = await registerMachine(relay, 'machine-a', T1)
    check('(b) offline twin still owns its slot after the failed takeover', !a3.sawVerify)
    a3.ctl.close()
    await sleep(150)

    // ── (d) never-registering /control socket is closed 4001 ───────────────
    {
      const idle = await openControl(relay)
      const t0 = Date.now()
      const closedIdle = await waitClose(idle.ws, 6000)
      check('(d) idle /control socket closed 4001 (register timeout)', closedIdle.code === 4001, `code ${closedIdle.code} after ${Date.now() - t0}ms`)
    }

    // ── (g) parked-socket caps: 6th unregistered socket from one IP refused ─
    {
      const parked: ControlHandle[] = []
      for (let i = 0; i < 5; i++) parked.push(await openControl(relay))
      const sixth = new WS(relay.url('/control'))
      ;(sixth).on('error', () => {})  // harness: server-side closes/SIGKILL teardown must not crash the runner
      const refused = await waitClose(sixth, 4000)
      check('(g) 6th parked /control socket from one IP refused 4002', refused.code === 4002, `code ${refused.code}`)
      for (const p of parked) p.close()
      await sleep(1600) // let the parked sockets hit their own 4001
    }

    // ── (e) /health: ok without counts; counts behind the relay key ────────
    {
      const open = await fetchJson(`${relay.httpBase()}/health`)
      check('(e) /health without key returns ok only', open.ok === true && !('machines' in open) && !('connections' in open), JSON.stringify(open))
    }
    await relay.stop()

    const keyed = await Relay.start({ requireKey: 'sekrit-relay-key' })
    try {
      const wrong = await fetchJson(`${keyed.httpBase()}/health`)
      check('(e) keyed relay /health without key hides counts', wrong.ok === true && !('machines' in wrong), JSON.stringify(wrong))
      const right = await fetchJson(`${keyed.httpBase()}/health?key=sekrit-relay-key`)
      check('(e) keyed relay /health?key=<key> exposes counts', right.ok === true && typeof right.machines === 'number', JSON.stringify(right))
      const viaHeader = await fetch(`${keyed.httpBase()}/health`, { headers: { 'X-Moch-Relay-Key': 'sekrit-relay-key' } }).then((r) => r.json() as Promise<Record<string, unknown>>)
      check('(e) keyed relay /health via X-Moch-Relay-Key exposes counts', viaHeader.ok === true && typeof viaHeader.machines === 'number', JSON.stringify(viaHeader))
      // registration on a keyed relay still works end-to-end with --relay-key
      const k = await registerMachine(keyed, 'machine-k', T2, { relayKey: 'sekrit-relay-key' })
      check('(e) keyed relay registration with relay key succeeds', k.sawVerify === true || k.ctl.messages.some((m) => m.t === 'registered'))
      k.ctl.close()
    } finally {
      await keyed.stop()
    }
  } finally {
    await relay.stop()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

const t0 = Date.now()
main().catch((e) => {
  console.error(e)
  process.exit(1)
}).finally(() => {
  console.log(`relay test finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
})
