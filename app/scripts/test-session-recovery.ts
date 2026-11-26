/**
 * Regression tests for:
 *  1. Embedded runtime boot backgrounding + foreground wakeup + retry fallback
 *     (src/lib/gateway.ts)
 *  2. Opening a persisted OpenCode session whose lazy Hermes spine was never
 *     written to state.db — must NOT fall back to newChat() when Hermes
 *     returns "session not found" (src/lib/chat.ts)
 *
 * Runs in plain Node with lightweight RN/AsyncStorage/HermesBridge stubs
 * (same createRequire + Module._load stub pattern as test-expo-go-imports.ts).
 *
 *   npx tsx scripts/test-session-recovery.ts
 */
import Module, { createRequire } from 'node:module'
import wsMod from 'ws'

export {}

;(globalThis as Record<string, unknown>).__DEV__ = true

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ── In-memory AsyncStorage + native stubs ──────────────────────────────────
const kv = new Map<string, string>()
const asyncStorage = {
  getItem: async (k: string) => kv.get(k) ?? null,
  setItem: async (k: string, v: string) => { kv.set(k, v) },
  removeItem: async (k: string) => { kv.delete(k) },
  multiRemove: async (keys: string[]) => { for (const k of keys) kv.delete(k) },
  getAllKeys: async () => [...kv.keys()],
}

let mockGw: {
  running: boolean
  ready: boolean
  port: number | null
  token: string | null
  workspace: string | null
  error: string | null
} | null = {
  running: true,
  ready: false,
  port: null,
  token: null,
  workspace: '/tmp/ws',
  error: null,
}
let onGatewayProbe: (() => void) | null = null

const origResolve = (Module as unknown as { _resolveFilename(req: string, ...rest: unknown[]): string })._resolveFilename
const load = Module as unknown as { _load(id: string, parent: unknown, isMain: boolean): unknown }
const origLoad = load._load
const stubMap = new Map<string, unknown>([
  ['@react-native-async-storage/async-storage', { __esModule: true, default: asyncStorage, ...asyncStorage }],
  ['expo-secure-store', {
    isAvailableAsync: async () => false,
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
  }],
  ['expo-file-system', {
    File: class { exists = false },
    Directory: class { exists = false },
    Paths: { document: '/tmp' },
  }],
  ['expo-file-system/legacy', {
    cacheDirectory: '/tmp/',
    documentDirectory: '/tmp/',
    getInfoAsync: async () => ({ exists: false }),
    makeDirectoryAsync: async () => {},
    readAsStringAsync: async () => '',
    writeAsStringAsync: async () => {},
    deleteAsync: async () => {},
  }],
  ['expo-image-manipulator', {
    ImageManipulator: { manipulate: () => ({ renderAsync: async () => ({ saveAsync: async () => ({ uri: '' }) }) }) },
    SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  }],
  ['expo-modules-core', {
    EventEmitter: class {
      addListener() { return { remove() {} } }
      removeAllListeners() {}
      emit() {}
    },
    NativeModule: class {},
    SharedObject: class {},
    requireNativeModule: () => ({}),
    requireOptionalNativeModule: () => null,
  }],
  ['expo/fetch', { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }],
  ['expo-notifications', {}],
  ['expo-constants', { default: { expoConfig: null } }],
  ['expo-device', { isDevice: false }],
  ['react-native', {
    Platform: { OS: 'android' },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    NativeModules: {
      HermesBridge: {
        getGateway: async () => {
          onGatewayProbe?.()
          return mockGw
        },
        status: async () => ({ running: true, pythonVersion: '3.11', hermesVersion: '1.0' }),
      },
    },
  }],
])

;(Module as unknown as { _resolveFilename(req: string, ...rest: unknown[]): string })._resolveFilename = function (
  req: string,
  ...rest: unknown[]
) {
  if (stubMap.has(req)) return req
  return origResolve.call(this, req, ...rest)
}
load._load = function (id: string, parent: unknown, isMain: boolean): unknown {
  if (stubMap.has(id)) return stubMap.get(id)
  return origLoad.call(this, id, parent, isMain)
}

const require_ = createRequire(import.meta.url)
const WebSocketServerCtor = ((wsMod as unknown as Record<string, unknown>).WebSocketServer ??
  (wsMod as unknown as Record<string, unknown>).Server) as typeof import('ws').WebSocketServer
const WsClientCtor = ((wsMod as unknown as Record<string, unknown>).WebSocket ?? wsMod) as unknown as new (
  url: string | URL,
  protocols?: string | string[],
  options?: Record<string, unknown>,
) => WebSocket
const dialUrls: string[] = []
const originalWebSocket = globalThis.WebSocket

class RecordingWebSocket extends WsClientCtor {
  constructor(url: string | URL, protocols?: string | string[], options?: Record<string, unknown>) {
    const address = String(url)
    dialUrls.push(address)
    // Keep the suite offline even if the retry guard regresses: a remote URL
    // is recorded, then rejected before DNS or any other network access.
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/api\/ws(?:\?|$)/.test(address)) {
      throw new Error(`offline test blocked non-embedded dial: ${address}`)
    }
    super(url, protocols, options)
  }
}

globalThis.WebSocket = RecordingWebSocket as unknown as typeof WebSocket

async function startReadyGateway(): Promise<{ wss: import('ws').WebSocketServer; port: number }> {
  const wss = new WebSocketServerCtor({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'event', event: 'gateway.ready', payload: { heartbeat: false, replay_epoch: 'guard' } }))
  })
  const addr = wss.address() as { port: number }
  return { wss, port: addr.port }
}

async function closeServer(wss: import('ws').WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()))
}

async function main() {
  // ── 1. Gateway boot backgrounding / foreground recovery ─────────────────
  const gw = require_('../src/lib/gateway') as typeof import('../src/lib/gateway')
  const resetGateway = async () => {
    await gw.clearConfig()
    kv.clear()
    gw.servers.set([])
    gw.activeServerId.set(null)
  }

  // Simulate connectThisPhone timing out while runtime wasn't ready yet
  // (e.g. backgrounded for > timeoutMs).
  mockGw = { running: true, ready: false, port: null, token: null, workspace: '/tmp/ws', error: null }
  let timeoutError: unknown = null
  try {
    await gw.connectThisPhone({ timeoutMs: 20, pollMs: 10 })
  } catch (e) {
    timeoutError = e
  }
  check(
    'connectThisPhone timeout keeps actionable retry copy',
    timeoutError instanceof Error && /try again in a moment/i.test(timeoutError.message),
    `error=${String(timeoutError)}`,
  )

  // Now runtime finished booting in background, and user hits retry when no saved config exists.
  const bootGateway = await startReadyGateway()
  const embeddedUrl = `ws://127.0.0.1:${bootGateway.port}/api/ws`
  mockGw = { running: true, ready: true, port: bootGateway.port, token: 'tok-abc', workspace: '/tmp/ws', error: null }
  dialUrls.length = 0
  let noSavedError: unknown = null
  try {
    await gw.retryNow()
  } catch (e) {
    noSavedError = e
  }
  check(
    'retryNow falls back to connectThisPhone when no saved config exists',
    noSavedError === null && gw.connectionState.get() === 'open' && dialUrls.length === 1 && dialUrls[0] === embeddedUrl,
    `error=${String(noSavedError)} urls=${dialUrls.join(',')}`,
  )
  gw.disconnect()

  // A saved loopback config is still retried directly, on its saved port.
  await resetGateway()
  kv.set('hermes.connection.host.v2', `127.0.0.1:${bootGateway.port}`)
  kv.set('hermes.connection.tls.v2', '0')
  kv.set('hermes.gateway.token', 'stale-local-token')
  dialUrls.length = 0
  let localRetryError: unknown = null
  try {
    await gw.retryNow()
  } catch (e) {
    localRetryError = e
  }
  check(
    'retryNow dials a saved loopback gateway',
    localRetryError === null && gw.connectionState.get() === 'open' && dialUrls.length === 1 && dialUrls[0] === embeddedUrl,
    `error=${String(localRetryError)} urls=${dialUrls.join(',')}`,
  )
  check(
    'local retry preserves the embedded gateway port and live runtime token',
    gw.connConfig.get()?.host === `127.0.0.1:${bootGateway.port}` && gw.connConfig.get()?.token === 'tok-abc',
  )
  gw.disconnect()

  // A saved remote config from the pairing era must fall back to embedded boot
  // without ever reaching the socket factory.
  await resetGateway()
  kv.set('hermes.connection.host.v2', 'gateway.example.com:443')
  kv.set('hermes.connection.tls.v2', '1')
  kv.set('hermes.gateway.token', 'retired-remote-token')
  dialUrls.length = 0
  let remoteRetryError: unknown = null
  try {
    await gw.retryNow()
  } catch (e) {
    remoteRetryError = e
  }
  check(
    'retryNow refuses a saved non-loopback gateway and falls back to local boot',
    remoteRetryError === null && gw.connectionState.get() === 'open' && dialUrls.length === 1 && dialUrls[0] === embeddedUrl,
    `error=${String(remoteRetryError)} urls=${dialUrls.join(',')}`,
  )
  check(
    'non-loopback retry never dials the saved remote config or adds an error',
    !dialUrls.some((url) => url.includes('gateway.example.com')) && gw.gatewayError.get() === null,
  )
  gw.disconnect()

  // Normal embedded boot is unchanged: it ignores a stale saved token and
  // dials the runtime's current loopback endpoint.
  await resetGateway()
  kv.set('hermes.connection.host.v2', `127.0.0.1:${bootGateway.port}`)
  kv.set('hermes.connection.tls.v2', '0')
  kv.set('hermes.gateway.token', 'stale-boot-token')
  dialUrls.length = 0
  let embeddedBootError: unknown = null
  try {
    await gw.connectThisPhone({ timeoutMs: 1_000, pollMs: 5 })
  } catch (e) {
    embeddedBootError = e
  }
  check(
    'connectThisPhone still dials the embedded loopback gateway directly',
    embeddedBootError === null && gw.connectionState.get() === 'open' && dialUrls.length === 1 && dialUrls[0] === embeddedUrl,
    `error=${String(embeddedBootError)} urls=${dialUrls.join(',')}`,
  )
  check(
    'connectThisPhone still replaces a stale saved token with the live runtime token',
    gw.connConfig.get()?.host === `127.0.0.1:${bootGateway.port}` && gw.connConfig.get()?.token === 'tok-abc',
  )
  gw.disconnect()
  await closeServer(bootGateway.wss)
  globalThis.WebSocket = originalWebSocket

  // Verify single-flight deduplication on concurrent connectThisPhone calls
  mockGw = { running: true, ready: false, port: null, token: null, workspace: '/tmp/ws', error: null }
  const p1 = gw.connectThisPhone({ timeoutMs: 120, pollMs: 30 })
  const p2 = gw.connectThisPhone({ timeoutMs: 120, pollMs: 30 })
  check('concurrent connectThisPhone calls share one in-flight promise', p1 === p2)
  gw.disconnect()
  const p3 = gw.connectThisPhone({ timeoutMs: 120, pollMs: 30 })
  check('connectThisPhone after disconnect allocates a fresh attempt immediately', p3 !== p1)
  gw.disconnect()
  await Promise.allSettled([p1, p2, p3])

  // Verify wakeEmbeddedPolls wakes a sleeping poll immediately on onForeground()
  let probeCount = 0
  onGatewayProbe = () => { probeCount++ }
  mockGw = { running: true, ready: false, port: null, token: null, workspace: '/tmp/ws', error: null }
  const longWait = gw.connectThisPhone({ timeoutMs: 10_000, pollMs: 5_000 })
  await new Promise((r) => setTimeout(r, 20))
  const countBeforeFg = probeCount
  gw.onForeground()
  await new Promise((r) => setTimeout(r, 20))
  check('onForeground immediately wakes sleeping boot poll', probeCount > countBeforeFg, `before=${countBeforeFg} after=${probeCount}`)

  // Verify backgrounded-past-deadline boot grants a foreground grace window rather than dying on the first tick
  onGatewayProbe = null
  gw.disconnect()
  await Promise.allSettled([longWait])
  const shortDeadlineWait = gw.connectThisPhone({ timeoutMs: 25, pollMs: 150 })
  await new Promise((r) => setTimeout(r, 40))
  let graceProbes = 0
  onGatewayProbe = () => { graceProbes++ }
  gw.onForeground()
  await new Promise((r) => setTimeout(r, 30))
  check('onForeground grants foreground grace polling even after wall-clock deadline elapsed', graceProbes >= 1, `graceProbes=${graceProbes}`)
  onGatewayProbe = null
  gw.disconnect()
  await Promise.allSettled([shortDeadlineWait])

  // ── 2. OpenCode old-session open must NOT fall back to newChat() ────────
  const chat = require_('../src/lib/chat') as typeof import('../src/lib/chat')

  const oldStoredId = '20261124_100000_dead01'
  const ocId = 'ses_oc_old_123'
  kv.set('hermes.opencode.map.v1', JSON.stringify({ [oldStoredId]: ocId }))
  kv.set('hermes.chat.thinker.v1', JSON.stringify({ [oldStoredId]: 'opencode' }))
  kv.set(
    `hermes.transcript.${oldStoredId}.v2`,
    JSON.stringify({
      v: 1,
      title: 'Old OpenCode Chat',
      messages: [{ id: 'm1', role: 'user', text: 'hello earlier', ts: 1000 }],
      tools: [],
    }),
  )

  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes(`/api/session/${encodeURIComponent(ocId)}/message`)) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'u1', type: 'user', time: { created: 1000 }, text: 'hello earlier' },
            { id: 'a1', type: 'assistant', time: { created: 1001 }, content: [{ type: 'text', text: 'hi back from oc' }] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  let createCalls = 0
  let resumeCalls = 0
  const wss = new WebSocketServerCtor({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const addr = wss.address() as { port: number }
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'event', event: 'gateway.ready', payload: { heartbeat: false, replay_epoch: 'e1' } }))
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string; params?: Record<string, unknown> }
      if (frame.method === 'session.resume') {
        resumeCalls++
        ws.send(JSON.stringify({ id: frame.id, error: { code: 4007, message: 'session not found' } }))
        return
      }
      if (frame.method === 'session.create') {
        createCalls++
        ws.send(
          JSON.stringify({
            id: frame.id,
            result: { session_id: `live_oc_${createCalls}`, stored_session_id: `20261125_220000_rec${createCalls}`, messages: [] },
          }),
        )
        return
      }
      if (frame.method === 'session.list') {
        ws.send(JSON.stringify({ id: frame.id, result: { sessions: [] } }))
        return
      }
      ws.send(JSON.stringify({ id: frame.id, result: {} }))
    })
  })

  mockGw = { running: true, ready: true, port: addr.port, token: 'test-tok', workspace: '/tmp/ws', error: null }
  await gw.connect({ host: `127.0.0.1:${addr.port}`, token: 'test-tok', tls: false, name: 'Test' })

  // 2a. openOcChat on existingStored where Hermes says "session not found"
  await chat.openOcChat(ocId, 'Old OpenCode Chat')
  const activeAfterOpen = chat.activeSession.get()
  const activeState = activeAfterOpen ? chat.sessionsById.get()[activeAfterOpen] : undefined
  check(
    'openOcChat recovers old OC session when Hermes session.resume returns session not found (no newChat fallback)',
    !!activeState &&
      !activeState.provisional &&
      !activeState.storedId.startsWith('new:') &&
      activeState.title === 'Old OpenCode Chat' &&
      activeState.messages.length >= 2 &&
      activeState.messages.some((m) => m.text.includes('hi back from oc')),
    `active=${activeAfterOpen} stored=${activeState?.storedId} title=${activeState?.title} msgs=${activeState?.messages.length}`,
  )
  check('openOcChat attempted resume then recovered via createSession once', resumeCalls === 1 && createCalls === 1)

  const mapAfter = JSON.parse(kv.get('hermes.opencode.map.v1') ?? '{}') as Record<string, string>
  check(
    'hermes.opencode.map.v1 migrates mapping from stale storedId to recovered storedId',
    !mapAfter[oldStoredId] && !!activeState?.storedId && mapAfter[activeState.storedId] === ocId,
  )

  // 2b. switchToSession directly on another mapped OpenCode storedId when Hermes returns "session not found"
  const oldStored2 = '20261124_100001_dead02'
  const ocId2 = 'ses_oc_old_456'
  kv.set('hermes.opencode.map.v1', JSON.stringify({ ...mapAfter, [oldStored2]: ocId2 }))
  kv.set(
    `hermes.transcript.${oldStored2}.v2`,
    JSON.stringify({
      v: 1,
      title: 'Second Old OC Chat',
      messages: [{ id: 'm2', role: 'user', text: 'remember me', ts: 2000 }],
      tools: [],
    }),
  )
  const switchedSid = await chat.switchToSession(oldStored2)
  const switchedState = chat.sessionsById.get()[switchedSid]
  check(
    'switchToSession recovers mapped OC session instead of calling newChat()',
    !!switchedState &&
      !switchedState.provisional &&
      !switchedState.storedId.startsWith('new:') &&
      switchedState.title === 'Second Old OC Chat' &&
      switchedState.messages.some((m) => m.text === 'remember me'),
    `sid=${switchedSid} stored=${switchedState?.storedId} title=${switchedState?.title}`,
  )

  // 2c. switchToSession on a non-OC deleted Hermes session STILL falls back to newChat()
  const deletedHermesId = '20261124_100002_gone03'
  const fallbackSid = await chat.switchToSession(deletedHermesId)
  const fallbackState = chat.sessionsById.get()[fallbackSid]
  check(
    'switchToSession still falls back to newChat() for deleted non-OC Hermes sessions',
    !!fallbackState && fallbackState.provisional === true && fallbackState.storedId.startsWith('new:'),
  )

  globalThis.fetch = origFetch
  gw.disconnect()
  await new Promise<void>((resolve) => wss.close(() => resolve()))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error('test-session-recovery crashed:', err)
  process.exit(1)
})
