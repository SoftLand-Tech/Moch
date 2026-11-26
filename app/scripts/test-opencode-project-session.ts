/**
 * Regression tests for OpenCode & Hermes project-scoped session creation,
 * verification/move repair, workspace refresh races, and unused draft re-homing.
 *
 * Run: cd app && npx tsx scripts/test-opencode-project-session.ts
 */

import { createRequire } from 'node:module'
import ws from 'ws'

export {}

const require = createRequire(import.meta.url)
const Module = require('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}

const asyncStorageBacking = new Map<string, string>()
const asyncStorageMock = {
  getItem: async (k: string) => asyncStorageBacking.get(k) ?? null,
  setItem: async (k: string, v: string) => void asyncStorageBacking.set(k, v),
  removeItem: async (k: string) => void asyncStorageBacking.delete(k),
  multiGet: async (keys: string[]) => keys.map((k) => [k, asyncStorageBacking.get(k) ?? null]),
  multiSet: async (pairs: [string, string][]) => {
    for (const [k, v] of pairs) asyncStorageBacking.set(k, v)
  },
}

let mockGatewayInfo: Record<string, unknown> | null = null

const origLoad = Module._load
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native') {
    return {
      Platform: { OS: 'android', select: (m: Record<string, unknown>) => m.android ?? m.default },
      AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
      NativeModules: {
        HermesBridge: {
          getGateway: async () => mockGatewayInfo,
          status: async () => ({ ready: true }),
          linuxStatus: async () => ({ installed: true }),
        },
      },
      NativeEventEmitter: class {
        addListener() {
          return { remove: () => {} }
        }
      },
    }
  }
  if (request === '@react-native-async-storage/async-storage') {
    return { default: asyncStorageMock, ...asyncStorageMock }
  }
  if (request === 'expo/fetch') {
    return { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }
  }
  if (request === '@react-native-community/netinfo') {
    return {
      default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) },
      addEventListener: () => () => {},
      fetch: async () => ({ isConnected: true }),
    }
  }
  if (
    request === 'expo' ||
    request.startsWith('expo-') ||
    request.startsWith('expo/')
  ) {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === '__esModule') return true
          if (prop === 'default') return {}
          if (prop === 'EventEmitter' || prop === 'NativeModule') {
            return class {}
          }
          return () => Promise.resolve(undefined)
        },
      },
    )
  }
  return origLoad.call(this, request, parent, isMain)
}

if (!(globalThis as Record<string, unknown>).WebSocket) {
  const WsCtor = (ws as unknown as { WebSocket?: unknown }).WebSocket ?? ws
  ;(globalThis as Record<string, unknown>).WebSocket = WsCtor
}
if (!globalThis.window) {
  ;(globalThis as unknown as Record<string, unknown>).window = globalThis
}
;(globalThis as Record<string, unknown>).__DEV__ = false

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms))

interface FetchCall {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

type FetchHandler = (call: FetchCall) => Promise<Response> | Response

interface RpcCall {
  method: string
  params: Record<string, unknown>
}

const READY = {
  type: 'gateway.ready',
  payload: { heartbeat: true, change_events: true, replay_epoch: 'oc-proj-test-1', skin: {} },
}

async function startMockGateway(
  handlers: Record<string, (params: Record<string, unknown>, socket: ws) => Promise<unknown> | unknown>,
) {
  const WebSocketServerImpl = ((ws as unknown as Record<string, unknown>).WebSocketServer ??
    (ws as unknown as Record<string, unknown>).Server) as typeof import('ws').WebSocketServer
  const wss = new WebSocketServerImpl({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const port = (wss.address() as { port: number }).port
  const rpcCalls: RpcCall[] = []
  let activeSocket: ws | null = null

  wss.on('connection', (socket) => {
    activeSocket = socket
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: READY }))
    socket.on('message', async (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: string | number; method?: string; params?: Record<string, unknown> }
      if (!msg.method) return
      if (msg.method === 'client.capabilities') {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { server_requests: [] } }))
        return
      }
      const params = msg.params ?? {}
      rpcCalls.push({ method: msg.method, params })
      const handler = handlers[msg.method]
      if (!handler) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
        return
      }
      try {
        const result = await handler(params, socket)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      } catch (err) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        )
      }
    })
  })

  return {
    port,
    host: `127.0.0.1:${port}`,
    url: `ws://127.0.0.1:${port}`,
    rpcCalls,
    sendEvent(type: string, payload: Record<string, unknown>) {
      activeSocket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, payload } }))
    },
    async close() {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}

async function main() {
  const ocClient = await import('../src/lib/opencodeClient')
  const ocChat = await import('../src/lib/opencodeChat')
  const workspace = await import('../src/lib/workspace')
  const sessionList = await import('../src/lib/sessionList')
  const gateway = await import('../src/lib/gateway')
  const thinker = await import('../src/lib/thinker')
  const chat = await import('../src/lib/chat')

  // ── 1. ocSessionDir ──────────────────────────────────────────────────────
  check(
    'ocSessionDir reads nested location.directory',
    ocClient.ocSessionDir({ location: { directory: '/workspace/proj-a' }, directory: '/workspace' }) ===
      '/workspace/proj-a',
  )
  check(
    'ocSessionDir falls back to legacy top-level directory',
    ocClient.ocSessionDir({ directory: '/workspace/legacy' }) === '/workspace/legacy',
  )
  check('ocSessionDir returns undefined on null/blank', ocClient.ocSessionDir({ location: { directory: '  ' } }) === undefined)

  // ── 2. ocCreateSession + createVerifiedOcSession ─────────────────────────
  const fetchCalls: FetchCall[] = []
  let fetchHandler: FetchHandler = async () => new Response('{}', { status: 200 })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers && typeof init.headers === 'object' && !(init.headers instanceof Headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = String(v)
    }
    let body: unknown = undefined
    if (typeof init?.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const call = { method, url, headers, body }
    fetchCalls.push(call)
    return fetchHandler(call)
  }) as typeof fetch

  // Primary create sends JSON body location: { directory }
  fetchCalls.length = 0
  fetchHandler = async (call) => {
    if (call.method === 'POST' && call.url.endsWith('/api/session')) {
      return new Response(
        JSON.stringify({ id: 'oc_1', title: 'New chat', location: { directory: '/workspace/alpha' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 404 })
  }
  const created = await ocClient.ocCreateSession('New chat', '/workspace/alpha')
  check(
    'ocCreateSession sends location.directory in JSON body on POST /api/session',
    fetchCalls.length === 1 &&
      fetchCalls[0].url === 'http://127.0.0.1:4096/api/session' &&
      JSON.stringify(fetchCalls[0].body) === JSON.stringify({ title: 'New chat', location: { directory: '/workspace/alpha' } }) &&
      !fetchCalls[0].headers['x-opencode-directory'],
    `calls=${JSON.stringify(fetchCalls)}`,
  )
  check('ocCreateSession returns location.directory', ocClient.ocSessionDir(created) === '/workspace/alpha')

  // 400 fallback to legacy query + header
  fetchCalls.length = 0
  let fallbackAttempt = 0
  fetchHandler = async (call) => {
    fallbackAttempt++
    if (fallbackAttempt === 1) {
      return new Response(JSON.stringify({ error: 'bad body' }), { status: 400 })
    }
    return new Response(
      JSON.stringify({ id: 'oc_legacy', title: 'Legacy', directory: '/workspace/alpha' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const legacyCreated = await ocClient.ocCreateSession('Legacy', '/workspace/alpha')
  check(
    'ocCreateSession falls back on 400 to ?directory= and X-Opencode-Directory',
    fetchCalls.length === 2 &&
      fetchCalls[1].url.includes('directory=%2Fworkspace%2Falpha') &&
      fetchCalls[1].headers['x-opencode-directory'] === encodeURIComponent('/workspace/alpha') &&
      ocClient.ocSessionDir(legacyCreated) === '/workspace/alpha',
    `calls=${JSON.stringify(fetchCalls)}`,
  )

  // createVerifiedOcSession repairs directory via POST /move if server minted in /workspace
  fetchCalls.length = 0
  fetchHandler = async (call) => {
    if (call.method === 'POST' && call.url.endsWith('/api/session')) {
      return new Response(
        JSON.stringify({ id: 'oc_repair', title: 'Chat', location: { directory: '/workspace' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (call.method === 'GET' && call.url.endsWith('/api/session/oc_repair')) {
      return new Response(
        JSON.stringify({ id: 'oc_repair', title: 'Chat', location: { directory: '/workspace' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (call.method === 'POST' && call.url.includes('/api/session/oc_repair/move')) {
      return new Response(null, { status: 204 })
    }
    return new Response('{}', { status: 404 })
  }
  const repaired = await ocChat.createVerifiedOcSession('Chat', '/workspace/alpha')
  check(
    'createVerifiedOcSession repairs mismatched directory via ocMoveSession',
    ocClient.ocSessionDir(repaired) === '/workspace/alpha' &&
      fetchCalls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.includes('/api/session/oc_repair/move') &&
          (c.body as { directory?: string })?.directory === '/workspace/alpha',
      ),
    `dir=${ocClient.ocSessionDir(repaired)}`,
  )

  // ── 3. Gateway-backed workspace races, sessionList & chat draft re-homing ─
  interface FakeProject {
    id: string
    label: string
    path: string
    sessionIds: string[]
  }
  const projectList: FakeProject[] = [
    { id: 'proj_a', label: 'Alpha', path: '/workspace/alpha', sessionIds: [] },
  ]
  let serverActiveProjectId: string | null = 'proj_a'
  const sessionStore: Record<string, { id: string; title?: string; project_id?: string; cwd?: string; kind?: string }> = {}
  let treeCallCount = 0
  let releaseFirstTree: (() => void) | null = null

  const gw = await startMockGateway({
    'projects.tree': async () => {
      treeCallCount++
      if (treeCallCount === 1) {
        // Deliberately stall the initial refresh so createProject overlaps it,
        // and still report the pre-create active_id ('proj_a').
        await new Promise<void>((r) => {
          releaseFirstTree = r
        })
        return {
          projects: [{ id: 'proj_a', label: 'Alpha', path: '/workspace/alpha', sessionIds: [] }],
          active_id: 'proj_a',
          unscoped_count: 0,
        }
      }
      return {
        projects: JSON.parse(JSON.stringify(projectList)),
        active_id: serverActiveProjectId,
        unscoped_count: 0,
      }
    },
    'projects.create': async (params) => {
      const label = String(params.name ?? 'Project')
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const p: FakeProject = {
        id: `proj_${slug}`,
        label,
        path: `/workspace/${slug}`,
        sessionIds: [],
      }
      projectList.push(p)
      if (params.use) serverActiveProjectId = p.id
      return { project: { id: p.id, name: label, primary_path: p.path } }
    },
    'projects.set_active': async (params) => {
      serverActiveProjectId = typeof params.id === 'string' ? params.id : null
      return { ok: true, active_id: serverActiveProjectId }
    },
    'session.list': async () => ({ sessions: Object.values(sessionStore), total: Object.keys(sessionStore).length }),
    'session.create': async (params) => {
      const id = `srv_${Object.keys(sessionStore).length + 1}`
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined
      const proj = projectList.find((p) => p.path === cwd)
      sessionStore[id] = {
        id,
        title: typeof params.title === 'string' ? params.title : undefined,
        project_id: typeof params.project_id === 'string' ? params.project_id : proj?.id,
        cwd,
        kind: typeof params.kind === 'string' ? params.kind : undefined,
      }
      if (proj) proj.sessionIds.push(id)
      return { id, session_id: id, session: sessionStore[id] }
    },
    'session.workspace.move': async (params) => {
      const sid = String(params.session_key ?? params.session_id ?? '')
      const cwd = typeof params.cwd === 'string' ? params.cwd : undefined
      const proj = projectList.find((p) => p.path === cwd)
      if (sessionStore[sid]) {
        for (const p of projectList) p.sessionIds = p.sessionIds.filter((x) => x !== sid)
        sessionStore[sid].cwd = cwd
        sessionStore[sid].project_id = proj?.id
        if (proj) proj.sessionIds.push(sid)
      }
      return { ok: true, session: sessionStore[sid] }
    },
    'session.delete': async (params) => {
      delete sessionStore[String(params.session_id ?? '')]
      return { ok: true }
    },
    'chat.submit': async () => ({ queued: true }),
    'chat.history': async () => ({ messages: [] }),
    'config.get': async () => ({}),
    'model.options': async () => ({ options: [], current: {} }),
  })

  try {
    mockGatewayInfo = {
      running: true,
      ready: true,
      port: gw.port,
      token: 'tok',
      workspace: '/workspace',
      error: '',
    }
    await gateway.connect({ host: gw.host, token: 'tok', tls: false })
    const deadline = Date.now() + 4000
    while (!gateway.isConnected.get() && Date.now() < deadline) await tick(15)
    check('mock gateway connected', gateway.isConnected.get())

    // Start slow refreshProjects() before createProject('Beta')
    const staleRefresh = workspace.refreshProjects()
    while (!releaseFirstTree) await tick(10)
    // Release stale tree ONLY after createProject resolves or concurrently: first call createProject while stale is inflight
    const createBetaPromise = workspace.createProject('Beta')
    await tick(20)
    releaseFirstTree!()
    await Promise.all([staleRefresh, createBetaPromise])

    check(
      'createProject selects newly created project despite overlapping pre-create refreshProjects',
      workspace.activeProjectIdAtom.get() === 'proj_beta' &&
        workspace.projectsAtom.get().some((p) => p.id === 'proj_beta'),
      `active=${workspace.activeProjectIdAtom.get()} projects=${workspace.projectsAtom.get().map((p) => p.id).join(',')}`,
    )

    // sessionList preserves optimistic project_id/cwd when server omits them
    const { rpc } = gateway
    sessionList._useSessionRpcForTests(rpc)
    sessionList.upsertOptimisticRow('srv_opt', 'Optimistic', {
      project_id: 'proj_beta',
      cwd: '/workspace/beta',
    })
    sessionStore['srv_opt'] = { id: 'srv_opt', title: 'Optimistic' }
    await sessionList.loadSessions()
    const optRow = sessionList.sessionRows.get().find((r) => r.id === 'srv_opt')
    check(
      'sessionList.loadSessions preserves optimistic project_id/cwd when server omits them',
      optRow?.project_id === 'proj_beta' && optRow?.cwd === '/workspace/beta',
      `row=${JSON.stringify(optRow)}`,
    )

    // Test unused 0-message draft re-homing for OpenCode
    let nextOcNum = 10
    const movedOcIds: Array<{ id: string; dir: string }> = []
    fetchCalls.length = 0
    fetchHandler = async (call) => {
      if (call.method === 'POST' && call.url.endsWith('/api/session')) {
        const body = call.body as { title?: string; location?: { directory?: string } }
        const id = `oc_d${nextOcNum++}`
        return new Response(
          JSON.stringify({ id, title: body.title ?? 'New chat', location: { directory: body.location?.directory ?? '/workspace' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const moveMatch = call.url.match(/\/api\/session\/([^/?]+)\/move/)
      if (call.method === 'POST' && moveMatch) {
        const dir = String((call.body as { directory?: string })?.directory ?? '')
        movedOcIds.push({ id: moveMatch[1], dir })
        return new Response(null, { status: 204 })
      }
      if (call.method === 'GET' && call.url.includes('/api/session/oc_')) {
        if (call.url.includes('/message')) {
          return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(
          JSON.stringify({ id: 'oc_d10', title: 'New chat', location: { directory: '/workspace/alpha' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (call.method === 'POST' && call.url.includes('/prompt_async')) {
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
    }

    thinker.thinkerAtom.set('opencode')
    await workspace.setActiveProject('proj_a')
    chat.activeSession.set(null)
    const freshOcDraftLiveId = await chat.ensureSession({ create: true })
    const freshOcDraftId = chat.activeStoredId.get() ?? ''
    check(
      'ensureSession materializes an unused OpenCode draft storedId scoped to proj_a',
      !!freshOcDraftLiveId &&
        !!freshOcDraftId &&
        sessionStore[freshOcDraftId]?.project_id === 'proj_a' &&
        sessionStore[freshOcDraftId]?.cwd === '/workspace/alpha',
      `draft=${freshOcDraftId} session=${JSON.stringify(sessionStore[freshOcDraftId])}`,
    )

    const gwCallsBefore = gw.rpcCalls.length
    await workspace.createProject('Gamma')
    await tick(40)
    const moveRpcAfterCreate = gw.rpcCalls
      .slice(gwCallsBefore)
      .find(
        (c) =>
          c.method === 'session.workspace.move' &&
          c.params.session_key === freshOcDraftId &&
          c.params.cwd === '/workspace/gamma',
      )
    check(
      'creating Gamma re-homes active unused OpenCode draft to proj_gamma',
      !!moveRpcAfterCreate && sessionStore[freshOcDraftId]?.project_id === 'proj_gamma',
      `draft=${freshOcDraftId} session=${JSON.stringify(sessionStore[freshOcDraftId])}`,
    )

    // Also test unused Hermes ('moch') draft re-homing on project switch
    thinker.thinkerAtom.set('moch')
    chat.activeSession.set(null)
    await chat.ensureSession({ create: true })
    const freshHermesDraftId = chat.activeStoredId.get() ?? ''
    check(
      'ensureSession under moch materializes draft scoped to proj_gamma',
      sessionStore[freshHermesDraftId]?.project_id === 'proj_gamma',
      `session=${JSON.stringify(sessionStore[freshHermesDraftId])}`,
    )
    await workspace.setActiveProject('proj_beta')
    await tick(40)
    check(
      'switching active project to proj_beta re-homes unused Hermes draft to proj_beta',
      sessionStore[freshHermesDraftId]?.project_id === 'proj_beta' &&
        sessionStore[freshHermesDraftId]?.cwd === '/workspace/beta',
      `session=${JSON.stringify(sessionStore[freshHermesDraftId])}`,
    )

    // openOcChat should force opencode thinker even if curState is an empty moch-stamped draft
    thinker.thinkerAtom.set('moch')
    await chat.newChat()
    const mochEmptyStoredId = chat.activeStoredId.get() ?? ''
    await chat.openOcChat('oc_opened_1', 'Opened OC Chat')
    const openedStoredId = chat.activeStoredId.get() ?? ''
    check(
      'openOcChat opens a storedId separate from moch-stamped empty draft and stamps opencode thinker',
      !!openedStoredId &&
        openedStoredId !== mochEmptyStoredId &&
        chat.thinkerForChat(openedStoredId) === 'opencode',
      `opened=${openedStoredId} mochDraft=${mochEmptyStoredId} thinker=${chat.thinkerForChat(openedStoredId)}`,
    )
  } finally {
    gateway.disconnect()
    await gw.close()
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
