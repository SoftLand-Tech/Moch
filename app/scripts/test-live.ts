/**
 * Test A — the real protocol client against the LIVE Hermes gateway.
 *
 * Exercises the exact calls the app makes, with the corrected params, using the
 * actual `JsonRpcGatewayClient` from src/protocol. Node 26 has a global
 * WebSocket, so no RN shim is needed.
 *
 *   npx tsx scripts/test-live.ts
 */
import fs from 'node:fs'
import { JsonRpcGatewayClient, type ServerRequest, type GatewayEvent } from '../src/protocol/json-rpc-gateway'

/** The loopback dashboard token, the same one the app pairs with. */
function readToken(): string {
  const path = process.env.HERMES_SERVE_ENV ?? `${process.env.HOME}/.config/hermes-serve.env`
  const token = fs.readFileSync(path, 'utf8').match(/HERMES_DASHBOARD_SESSION_TOKEN=(.+)/)?.[1]?.trim()
  if (!token) {
    console.error(`No HERMES_DASHBOARD_SESSION_TOKEN in ${path}.`)
    console.error('Set HERMES_SERVE_ENV to point at the right file.')
    process.exit(1)
  }
  return token
}

const token = readToken()

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const events: GatewayEvent[] = []
const serverReqs: ServerRequest[] = []
/** Every frame the client puts on the wire — proves what we actually send. */
const sentFrames: string[] = []

async function main() {
  const client = new JsonRpcGatewayClient({
    connectTimeoutMs: 12_000,
    requestTimeoutMs: 30_000,
    onRequestHandlerError: (e) => check('server-request handler did not crash', false, String(e)),
    socketFactory: (url: string) => {
      const ws = new WebSocket(url)
      const rawSend = ws.send.bind(ws)
      ws.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        sentFrames.push(String(data))
        rawSend(data as string)
      }
      return ws as unknown as WebSocket
    },
  })

  client.onAny((e) => events.push(e))
  client.onRequest((req: ServerRequest) => {
    serverReqs.push(req)
    return true // claim it so the channel doesn't answer -32601
  })

  const url = `ws://127.0.0.1:9119/api/ws?token=${encodeURIComponent(token)}`
  await client.connect(url)
  check('websocket connect', client.connectionState === 'open')

  // gateway.ready arrives before any request; give it a tick.
  await new Promise((r) => setTimeout(r, 700))
  check('gateway.ready observed', events.some((e) => e.type === 'gateway.ready'))

  const capFrames = sentFrames.filter((f) => f.includes('"client.capabilities"') && f.includes('server_requests'))
  check(
    'client.capabilities {server_requests:true} sent on the wire',
    capFrames.length === 1,
    capFrames[0] ? capFrames[0].slice(0, 90) : 'never sent',
  )

  // ── session.create WITHOUT the invalid `rows` key ──────────────────────
  let sidA = ''
  let storedA = ''
  try {
    const r = await client.request<{ session_id: string; stored_session_id: string }>('session.create', {
      title: 'test-A',
      cols: 120,
      source: 'mobile',
    })
    sidA = r.session_id
    storedA = r.stored_session_id
    check('session.create (no `rows` key)', !!sidA, `live=${sidA.slice(0, 14)} stored=${String(storedA).slice(0, 14)}`)
  } catch (e) {
    check('session.create (no `rows` key)', false, (e as Error).message)
  }

  // The old param must now be proven bad so the fix is pinned.
  try {
    await client.request('session.create', { title: 'x', cols: 120, rows: 30 })
    check('session.create rejects `rows` (regression guard)', false, 'accepted an invalid key')
  } catch (e) {
    check('session.create rejects `rows` (regression guard)', true, `code ${(e as { code?: number }).code}`)
  }

  // ── multi-session: two live sessions, independent ids ─────────────────
  let sidB = ''
  try {
    const r = await client.request<{ session_id: string; stored_session_id: string }>('session.create', {
      title: 'test-B',
      cols: 120,
      source: 'mobile',
    })
    sidB = r.session_id
    check('second session created concurrently', !!sidB && sidB !== sidA)
  } catch (e) {
    check('second session created concurrently', false, (e as Error).message)
  }

  try {
    const r = await client.request<{ sessions?: unknown[] }>('session.active_list', {})
    const n = (r.sessions ?? []).length
    check('both sessions live at once', n >= 2, `${n} live sessions`)
  } catch (e) {
    check('both sessions live at once', false, (e as Error).message)
  }

  // ── resume by STORED id ───────────────────────────────────────────────
  if (storedA) {
    try {
      const r = await client.request<{ session_id: string }>('session.resume', { session_id: storedA, cols: 120 })
      check('session.resume by stored id', r.session_id === sidA, `returned ${r.session_id?.slice(0, 14)}`)
    } catch (e) {
      check('session.resume by stored id', false, (e as Error).message)
    }
  }

  // ── session.list without the invalid `search` key ─────────────────────
  try {
    const r = await client.request<{ sessions?: unknown[] }>('session.list', { limit: 200 })
    check('session.list (no `search` key)', Array.isArray(r.sessions), `${(r.sessions ?? []).length} sessions`)
  } catch (e) {
    check('session.list (no `search` key)', false, (e as Error).message)
  }

  // ── slash command catalog + execution ─────────────────────────────────
  try {
    const r = await client.request<{ commands?: Record<string, unknown>; skills?: Record<string, unknown> }>('commands.catalog', {})
    const n = Object.keys(r.commands ?? {}).length
    check('commands.catalog', n > 50, `${n} commands, ${Object.keys(r.skills ?? {}).length} skills`)
  } catch (e) {
    check('commands.catalog', false, (e as Error).message)
  }

  if (sidA) {
    try {
      const r = await client.request<{ output: string }>('slash.exec', { session_id: sidA, command: '/status' })
      check('slash.exec {command:"/status"}', typeof r.output === 'string' && r.output.length > 0, r.output?.split('\n')[1] ?? '')
    } catch (e) {
      check('slash.exec {command:"/status"}', false, (e as Error).message)
    }
    // built-ins must fall through command.dispatch (4018) to slash.exec
    try {
      await client.request('command.dispatch', { name: 'status', session_id: sidA })
      check('command.dispatch rejects built-in with 4018 (falls through)', false, 'unexpectedly accepted')
    } catch (e) {
      check('command.dispatch rejects built-in with 4018 (falls through)', (e as { code?: number }).code === 4018, `code ${(e as { code?: number }).code}`)
    }
  }

  // ── config keys the Controls screen uses ──────────────────────────────
  try {
    const r = await client.request<{ value?: string; display?: string }>('config.get', { key: 'reasoning' })
    check('config.get {key:"reasoning"}', typeof r.value === 'string', `value=${r.value} display=${r.display}`)
  } catch (e) {
    check('config.get {key:"reasoning"}', false, (e as Error).message)
  }
  try {
    await client.request('config.get', { key: 'agent.reasoning_effort' })
    check('config.get rejects the old key (regression guard)', false, 'accepted')
  } catch (e) {
    check('config.get rejects the old key (regression guard)', true, `code ${(e as { code?: number }).code}`)
  }

  // ── thinking preferences: session pin vs saved-everywhere default ──────
  const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  if (sidA) {
    try {
      await client.request('config.set', { key: 'reasoning', value: 'low', session_id: sidA })
      const r = await client.request<{ value?: string }>('config.get', { key: 'reasoning', session_id: sidA })
      check('session-scoped effort pins the session', r.value === 'low', `value=${r.value}`)
    } catch (e) {
      check('session-scoped effort pins the session', false, (e as Error).message)
    }
    try {
      // Same-value write-back proves the scope:'global' frame is accepted
      // without touching the user's saved default.
      const g = await client.request<{ value?: string }>('config.get', { key: 'reasoning' })
      if (typeof g.value === 'string' && EFFORTS.includes(g.value)) {
        await client.request('config.set', { key: 'reasoning', value: g.value, scope: 'global', session_id: sidA })
        const after = await client.request<{ value?: string }>('config.get', { key: 'reasoning' })
        check('global effort frame accepted, default unchanged', after.value === g.value, `${g.value} -> ${after.value}`)
      } else {
        check('global effort frame accepted, default unchanged', true, `skipped write-back (current: ${g.value})`)
      }
    } catch (e) {
      check('global effort frame accepted, default unchanged', false, (e as Error).message)
    }
  }

  // ── provider inventory + disconnect wiring (Models screen) ─────────────
  try {
    const r = await client.request<{ providers?: Array<Record<string, unknown>> }>('model.options', {
      include_unconfigured: true,
    })
    const rows = r.providers ?? []
    const withStatus = rows.filter((p) => typeof p.authenticated === 'boolean').length
    const connectable = rows.filter((p) => p.authenticated === false && p.auth_type === 'api_key').length
    check('model.options include_unconfigured rows carry status', withStatus > 0, `${withStatus}/${rows.length} rows, ${connectable} connectable`)
  } catch (e) {
    check('model.options include_unconfigured rows carry status', false, (e as Error).message)
  }
  try {
    await client.request('model.disconnect', { slug: 'no-such-provider-xyz' })
    check('model.disconnect unknown slug refuses (4005)', false, 'accepted')
  } catch (e) {
    check('model.disconnect unknown slug refuses (4005)', (e as { code?: number }).code === 4005, `code ${(e as { code?: number }).code}`)
  }

  // ── replay: session.events.since + per-session seq watermarks ──────────
  if (sidA) {
    try {
      const r = await client.request<{ events?: unknown[]; epoch?: string; truncated?: boolean }>('session.events.since', {
        session_id: sidA,
        last_seen: 0,
      })
      check('session.events.since', Array.isArray(r.events) && !!r.epoch, `epoch=${String(r.epoch).slice(0, 8)} truncated=${r.truncated}`)
    } catch (e) {
      check('session.events.since', false, (e as Error).message)
    }
  }

  // ── heartbeat: the transport answers gateway.ping ─────────────────────
  try {
    const r = await client.request<{ ok?: boolean }>('gateway.ping', {}, 8000)
    check('gateway.ping answered', r?.ok === true)
  } catch (e) {
    check('gateway.ping answered', false, (e as Error).message)
  }

  for (const s of [sidA, sidB]) {
    if (s) await client.request('session.delete', { session_id: s }).catch(() => {})
  }
  client.close()

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
