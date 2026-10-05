/**
 * Test B — the v7 server->client request path, against a controllable fake gateway.
 *
 * The live gateway will not ask a question on demand, so this stands up a
 * minimal v7 server that speaks the exact wire contract from
 * `tui_gateway/server_requests.py`:
 *   - `gateway.ready` arrives unprompted, BEFORE the client reads anything
 *   - questions are JSON-RPC REQUESTS (string id `srq-<hex>`, a `method`, and
 *     `params`) that the client must answer with a RESPONSE carrying the same id
 *   - there is no paired `*.request` notification and no `*.respond` method
 *
 * It also covers the multi-session event contract: seq watermarks, replay with
 * `open_requests`, and that a question for session A never lands in session B.
 *
 *   npx tsx scripts/test-protocol.ts
 */
import ws from 'ws'
import { JsonRpcGatewayClient, type ServerRequest, type GatewayEvent } from '../src/protocol/json-rpc-gateway'

// The installed `ws` is old enough to export the server constructor as
// `Server`; newer builds call it `WebSocketServer`. Types describe the modern
// shape, so resolve the runtime name defensively.
const WebSocketServerImpl = ((ws as unknown as Record<string, unknown>).WebSocketServer ??
  (ws as unknown as Record<string, unknown>).Server) as typeof import('ws').WebSocketServer

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const SESSION_A = 'live-aaaa'
const SESSION_B = 'live-bbbb'
const READY = {
  type: 'gateway.ready',
  payload: { heartbeat: true, change_events: true, replay_epoch: 'testepoch0001', skin: {} },
}

type Handler = (ws: WebSocket, frame: any) => void
type WebSocket = import('ws').WebSocket

/** Explicit frame type for anything the fake gateway reads off the wire. */
interface WireFrame {
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
  [k: string]: unknown
}

/**
 * Accumulators that are assigned inside a socket callback need an explicit
 * nullable type — otherwise TS control-flow narrows them to `never` at the
 * assertion site.
 */
function slot<T>(): { get: () => T | null; set: (v: T) => void } {
  let value: T | null = null
  return { get: () => value, set: (v: T) => { value = v } }
}

async function withServer<T>(onMessage: Handler, fn: (url: string) => Promise<T>): Promise<T> {
  const wss = new WebSocketServerImpl({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  wss.on('connection', (ws) => {
    // The real server writes gateway.ready immediately, before reading anything.
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: READY }))
    ws.on('message', (data: import('ws').RawData) => {
      let frame: WireFrame
      try {
        frame = JSON.parse(String(data)) as WireFrame
      } catch {
        return
      }
      void onMessage(ws, frame)
    })
  })
  try {
    return await fn(`ws://127.0.0.1:${port}/api/ws?token=t`)
  } finally {
    wss.close()
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── 1. The approval round trip ─────────────────────────────────────────────
async function testApprovalRoundTrip() {
  console.log('\n— approval round trip —')
  const APPROVAL_ID = 'srq-aaaabbbbcccc'
  const answer = slot<WireFrame>()
  // `requested` is assigned from a callback, so collect into an array instead.
  const seen: ServerRequest[] = []
  const requested = () => seen[0]

  await withServer(
    (ws, frame) => {
      if (frame.method === 'client.capabilities') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { server_requests: ['approval', 'clarify', 'sudo', 'secret'] } }))
        // Ask a question the way the backend does: a request, not a notification.
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: APPROVAL_ID,
            method: 'approval',
            params: {
              session_id: SESSION_A,
              request_id: 'ap-77',
              command: 'rm -rf /tmp/important',
              description: 'Delete a directory',
              choices: ['once', 'session', 'always', 'deny'],
              allow_permanent: true,
              allow_session: true,
            },
          }),
        )
        return
      }
      if (frame.id === APPROVAL_ID) answer.set(frame)
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
    },
    async (url) => {
      const client = new JsonRpcGatewayClient({ connectTimeoutMs: 8000, requestTimeoutMs: 8000 })
      client.onRequest((req) => {
        seen.push(req)
        // Answer the way chat.ts does.
        req.respond({ choice: 'once' })
        return true
      })
      await client.connect(url)
      await wait(500)
      client.close()
    },
  )

  check('server->client request dispatched to the handler', seen.length === 1)
  check('  handler saw the right method', requested()?.method === 'approval', String(requested()?.method))
  check('  handler saw the right id', requested()?.id === APPROVAL_ID, String(requested()?.id))
  check('  session_id came through', requested()?.sessionId === SESSION_A, String(requested()?.sessionId))
  check(
    '  command text preserved',
    (requested()?.params as { command?: string } | undefined)?.command === 'rm -rf /tmp/important',
  )
  const af = answer.get()
  check('client answered with a RESPONSE frame', af !== null)
  check('  answer carries the same id', af?.id === APPROVAL_ID, String(af?.id))
  check('  answer result is {choice:"once"}', (af?.result as { choice?: string } | undefined)?.choice === 'once', JSON.stringify(af?.result))
  check('  answer is not a method call (no *.respond)', af?.method === undefined)
}

// ── 2. Unhandled request must be answered -32601 ──────────────────────────
async function testUnhandledAnswers() {
  console.log('\n— unhandled request is withdrawn, not waited out —')
  const ID = 'srq-zzzz11112222'
  const answer = slot<WireFrame>()

  await withServer(
    (ws, frame) => {
      if (frame.method === 'client.capabilities') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: ID, method: 'preview.act', params: { session_id: SESSION_A, action: 'click' } }))
        return
      }
      if (frame.id === ID) answer.set(frame)
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
    },
    async (url) => {
      const client = new JsonRpcGatewayClient({ connectTimeoutMs: 8000 })
      // No handler registered — the client should decline.
      client.onRequest(() => false)
      await client.connect(url)
      await wait(400)
      client.close()
    },
  )

  const a = answer.get()
  check('unhandled request gets an answer', a !== null)
  check('  answered with -32601', a?.error?.code === -32601, `code ${a?.error?.code}`)
  check('  message names the method', String(a?.error?.message ?? '').includes('preview.act'), String(a?.error?.message))
}

// ── 3. A crashing handler must not stall the backend ─────────────────────
async function testHandlerCrash() {
  console.log('\n— a crashing handler is contained —')
  const ID = 'srq-crash123456'
  const answer = slot<WireFrame>()

  await withServer(
    (ws, frame) => {
      if (frame.method === 'client.capabilities') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: ID, method: 'clarify', params: { session_id: SESSION_A, question: 'Which?' } }))
        return
      }
      if (frame.id === ID) answer.set(frame)
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
    },
    async (url) => {
      const client = new JsonRpcGatewayClient({ connectTimeoutMs: 8000 })
      client.onRequest(() => {
        throw new Error('UI blew up')
      })
      await client.connect(url)
      await wait(400)
      client.close()
    },
  )

  const a = answer.get()
  check('crashing handler answered the request', a !== null)
  check('  answered with -32603', a?.error?.code === -32603, `code ${a?.error?.code}`)
}

// ── 4. Multi-session isolation: events + questions stay in their session ──
async function testSessionIsolation() {
  console.log('\n— multi-session routing —')
  const CLARIFY_B = 'srq-bbbb11112222'
  const evs: Array<{ type: string; sid?: string; seq?: number }> = []
  const questions: ServerRequest[] = []
  const clarifyAnswer = slot<WireFrame>()

  await withServer(
    (ws, frame) => {
      if (frame.method === 'client.capabilities') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
        const ev = (type: string, sid: string, seq: number, payload: unknown) =>
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sid, seq, payload } }))

        ev('message.start', SESSION_A, 1, {})
        ev('message.delta', SESSION_A, 2, { text: 'hello from A' })
        ev('message.start', SESSION_B, 1, {})
        ev('message.delta', SESSION_B, 2, { text: 'hello from B' })
        // Session-less global — must not be attributed to either session.
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'cron.changed', payload: {} } }))

        // A question for session B only.
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: CLARIFY_B, method: 'clarify', params: { session_id: SESSION_B, question: 'Which one?', choices: ['x', 'y'] } }))
        return
      }
      if (frame.id === CLARIFY_B) clarifyAnswer.set(frame)
      else ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
    },
    async (url) => {
      const client = new JsonRpcGatewayClient({ connectTimeoutMs: 8000 })
      client.onAny((e: GatewayEvent) => evs.push({ type: e.type, sid: e.session_id, seq: e.seq }))
      client.onRequest((req) => {
        questions.push(req)
        req.respond({ answer: 'x' })
        return true
      })
      await client.connect(url)
      await wait(500)

      const marks = client.getSeqWatermarks()
      check('per-session seq watermarks tracked separately', marks[SESSION_A] === 2 && marks[SESSION_B] === 2, JSON.stringify(marks))
      check('global event carried no session_id', evs.some((e) => e.type === 'cron.changed' && e.sid === undefined))
      client.close()
    },
  )

  const deltas = evs.filter((e) => e.type === 'message.delta')
  check('both sessions streamed', deltas.length === 2)
  check('each delta stayed in its own session', new Set(deltas.map((e) => e.sid)).size === 2)
  check('clarify routed with its own session', questions[0]?.sessionId === SESSION_B, String(questions[0]?.sessionId))
  check('clarify answered {answer:"x"}', (clarifyAnswer.get()?.result as { answer?: string } | undefined)?.answer === 'x', JSON.stringify(clarifyAnswer.get()?.result))
}

// ── 5. Reconnect: open_requests survive, seq replay does not double-apply ─
async function testReplayAndOpenRequests() {
  console.log('\n— reconnect replay + open_requests —')
  const OPEN_ID = 'srq-open1234567'
  let phase: 'first' | 'second' = 'first'
  const deltas: string[] = []
  const replayed: ServerRequest[] = []

  // Two sequential connections on one server: drop, then redial.
  const wss = new WebSocketServerImpl({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: READY }))
    ws.on('message', (data: import('ws').RawData) => {
      const frame = JSON.parse(String(data)) as WireFrame
      if (frame.method === 'client.capabilities') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
        if (phase === 'first') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: SESSION_A, seq: 1, payload: { text: 'one' } } }))
          ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: SESSION_A, seq: 2, payload: { text: 'two' } } }))
          phase = 'second'
          setTimeout(() => ws.terminate(), 30) // simulate a drop
        }
        return
      }
      if (frame.method === 'session.events.since') {
        // Replay the gap (seq 2) plus an unanswered question, as the real
        // gateway does after a drop.
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              events: [{ type: 'message.delta', session_id: SESSION_A, seq: 2, payload: { text: 'two' } }],
              latest_seq: 2,
              truncated: false,
              count: 1,
              epoch: 'testepoch0001',
              open_requests: [{ id: OPEN_ID, method: 'approval', params: { session_id: SESSION_A, request_id: 'r', command: 'ls' } }],
            },
          }),
        )
      } else if (frame.id && typeof frame.id === 'string' && frame.id.startsWith('srq-')) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { choice: 'deny' } }))
      } else {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} }))
      }
    })
  })

  const client = new JsonRpcGatewayClient({ connectTimeoutMs: 8000, requestTimeoutMs: 8000 })
  client.onAny((e: GatewayEvent) => {
    if (e.type === 'message.delta') deltas.push(String((e.payload as any)?.text ?? ''))
  })
  client.onRequest((req) => {
    replayed.push(req)
    req.respond({ choice: 'deny' })
    return true
  })

  await client.connect(`ws://127.0.0.1:${port}/api/ws?token=t`)
  await wait(400)
  // Redial after the simulated drop.
  await client.connect(`ws://127.0.0.1:${port}/api/ws?token=t`).catch(() => {})
  await wait(600)
  client.close()
  wss.close()

  check('pre-drop deltas arrived', deltas.includes('one') && deltas.includes('two'), deltas.join(','))
  check('replayed seq 2 was NOT applied twice', deltas.filter((x) => x === 'two').length === 1, `count=${deltas.filter((x) => x === 'two').length}`)
  check('open_requests re-delivered after reconnect', replayed.length === 1, `${replayed.length} question(s)`)
  check('  re-delivered as replayed:true', replayed[0]?.replayed === true, String(replayed[0]?.replayed))
  check('  same id reused', replayed[0]?.id === OPEN_ID, String(replayed[0]?.id))
}

async function main() {
  await testApprovalRoundTrip()
  await testUnhandledAnswers()
  await testHandlerCrash()
  await testSessionIsolation()
  await testReplayAndOpenRequests()
  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
