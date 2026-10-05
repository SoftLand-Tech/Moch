import { atom, computed } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { JsonRpcGatewayClient, type GatewayEvent, type ConnectionState, type ServerRequest } from '../protocol/json-rpc-gateway'
import { RnWebSocketAdapter } from '../protocol/rn-socket'
import { log } from './log'
import { getEmbeddedGateway } from './hermesRuntime'

export interface ConnConfig {
  host: string // "127.0.0.1:9119" or "myserver.tailnet.ts.net:443"
  token: string
  tls: boolean
  /** Machine label for the saved list (from the QR's name=). Optional. */
  name?: string
}

const HOST_KEY = 'hermes.connection.host.v2'
const TLS_KEY = 'hermes.connection.tls.v2'
const TOKEN_KEY = 'hermes.gateway.token'
const LEGACY_KEY = 'hermes.connection.v1'

// Remembered computers — the list survives pairing more than one machine.
const SERVERS_KEY = 'hermes.servers.v1'
const ACTIVE_SERVER_KEY = 'hermes.activeServer.v1'
const SERVER_TOKEN_PREFIX = 'hermes.server.token.'

/** A paired computer. Tokens live per-id in SecureStore, never in this list. */
export interface SavedServer {
  id: string
  name: string
  host: string
  tls: boolean
  addedAt: number
  lastUsedAt: number
}

export const servers = atom<SavedServer[]>([])
export const activeServerId = atom<string | null>(null)

export const connectionState = atom<ConnectionState>('idle')
export const connConfig = atom<ConnConfig | null>(null)
export const gatewayError = atom<string | null>(null)
export const reconnectAttempt = atom(0)
export const isConnected = computed(connectionState, (s) => s === 'open')
// Back-compat alias (old code imported `connected`)
export const connected = isConnected

let client: JsonRpcGatewayClient | null = null
let stopEvents: (() => void) | null = null
let stopState: (() => void) | null = null
let stopRequests: (() => void) | null = null
let wantConnection = false
let lastConfig: ConnConfig | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let connectGen = 0
let manualClose = false
// Serializes the per-dial persistence writes (saveConfig + upsertServer) so
// overlapping dials can't interleave upsertServer's server-list
// read-modify-write. The writes OVERLAP the WebSocket handshake — they never
// gate it — but stay ordered with respect to each other.
let persistChain: Promise<void> = Promise.resolve()

type DialHook = (c: ConnConfig) => Promise<void>
const dialHooks = new Set<DialHook>()
/**
 * Register a callback that runs on every dial with the VALIDATED config,
 * before the handshake and the persist chain. Backend-identity scoping
 * (backendIdentity.ts) hangs off this so every dial path — boot connect,
 * deep-link pair, saved-server switch, reconnect retry — re-checks without
 * gateway importing the cache modules (they import gateway; a direct import
 * here would be a cycle). A throwing hook is logged and skipped: it must
 * never block connecting.
 */
export function onDialConfig(hook: DialHook): () => void {
  dialHooks.add(hook)
  return () => { dialHooks.delete(hook) }
}

type EventSink = (e: GatewayEvent) => void
const sinks = new Set<EventSink>()
export function onEvent(sink: EventSink): () => void {
  sinks.add(sink)
  return () => { sinks.delete(sink) }
}
function dispatch(e: GatewayEvent) {
  for (const s of sinks) {
    try { s(e) } catch (err) { log('error', 'gateway', `sink threw: ${String(err)}`) }
  }
}

type RequestSink = (req: ServerRequest) => boolean | void
const requestSinks = new Set<RequestSink>()
/**
 * Register a handler for server->client requests (approval, clarify, sudo,
 * secret, ...). Return `false` to decline; an unhandled request is answered
 * `-32601` so the backend stops waiting instead of burning its deadline.
 */
export function onServerRequest(sink: RequestSink): () => void {
  requestSinks.add(sink)
  return () => { requestSinks.delete(sink) }
}
function dispatchRequest(req: ServerRequest): boolean {
  for (const s of requestSinks) {
    let accepted: boolean | void
    try {
      accepted = s(req)
    } catch (err) {
      log('error', 'gateway', `server-request handler threw for ${req.method}: ${String(err)}`)
      return false
    }
    if (accepted !== false) return true
  }
  return false
}

/** Normalize "host[:port]" — accepts bare host, host:port, or full URLs. Throws on garbage. */
export function normalizeHost(raw: string): string {
  let h = raw.trim()
  if (!h) throw new Error('Enter the server address.')
  h = h.replace(/^(wss?|https?):\/\//i, '').replace(/\/+$/, '')
  // strip path/query if user pasted a full URL
  const slash = h.indexOf('/')
  if (slash >= 0) h = h.slice(0, slash)
  const q = h.indexOf('?')
  if (q >= 0) h = h.slice(0, q)
  h = h.trim()
  if (!h || /\s/.test(h)) throw new Error('Invalid server address.')
  // basic hostname:port sanity — letters, digits, dots, dashes, colons (ipv6), brackets
  if (!/^[A-Za-z0-9.\-_:[\]]+$/.test(h)) throw new Error('Invalid server address.')
  if (h.length > 253) throw new Error('Server address too long.')
  return h
}

export function validateConfig(c: ConnConfig): ConnConfig {
  const host = normalizeHost(c.host)
  const token = c.token.trim()
  if (!token) throw new Error('Enter the token.')
  if (token.length > 4096) throw new Error('Token too long.')
  const name = (c.name ?? '').trim().slice(0, 40)
  return { host, token, tls: !!c.tls, ...(name ? { name } : {}) }
}

function wsUrl(c: ConnConfig): string {
  const base = `${c.tls ? 'wss' : 'ws'}://${c.host}/api/ws?token=${encodeURIComponent(c.token)}`
  // Advertise the Expo push token on the dial URL so the backend can knock
  // while the socket is down. `./push` is required LAZILY, never imported:
  // plain-node suites import this module, and push.ts drags in
  // expo/react-native modules that cannot load outside the app runtime.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const push = require('./push') as typeof import('./push') | undefined
    const pushToken = push?.currentPushToken?.()
    if (pushToken) return `${base}&push=${encodeURIComponent(pushToken)}`
  } catch {}
  return base
}

/** Scrubbed URL safe for logs/UI — never prints the token. */
export function redactedUrl(c: ConnConfig): string {
  return `${c.tls ? 'wss' : 'ws'}://${c.host}/api/ws?token=***`
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().split(':')[0].replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('192.168.') || h.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

async function secureAvailable(): Promise<boolean> {
  try { return await SecureStore.isAvailableAsync() } catch { return false }
}

// ---- Remembered computers --------------------------------------------------

function newServerId(): string {
  return `srv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

async function readServerList(): Promise<SavedServer[]> {
  try {
    const raw = await AsyncStorage.getItem(SERVERS_KEY)
    const parsed = raw ? (JSON.parse(raw) as SavedServer[]) : []
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id && s.host) : []
  } catch {
    return []
  }
}

async function writeServerList(list: SavedServer[]): Promise<void> {
  await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(list))
  servers.set(list)
}

async function readTokenFor(id: string): Promise<string | null> {
  const key = SERVER_TOKEN_PREFIX + id
  if (await secureAvailable()) {
    try { return await SecureStore.getItemAsync(key) } catch { return null }
  }
  try { return await AsyncStorage.getItem(key) } catch { return null }
}

async function writeTokenFor(id: string, token: string): Promise<void> {
  const key = SERVER_TOKEN_PREFIX + id
  if (await secureAvailable()) {
    await SecureStore.setItemAsync(key, token)
    return
  }
  try { await AsyncStorage.setItem(key, token) } catch {}
}

async function deleteTokenFor(id: string): Promise<void> {
  const key = SERVER_TOKEN_PREFIX + id
  try { await SecureStore.deleteItemAsync(key) } catch {}
  try { await AsyncStorage.removeItem(key) } catch {}
}

/** Sync the reactive atoms from storage. Cheap — call at boot and after mutations. */
export async function refreshServers(): Promise<SavedServer[]> {
  const list = await readServerList()
  servers.set(list)
  if (!activeServerId.get()) {
    try {
      const raw = await AsyncStorage.getItem(ACTIVE_SERVER_KEY)
      if (raw && list.some((s) => s.id === raw)) activeServerId.set(raw)
    } catch {}
  }
  return list
}

/** Add (or refresh) a paired computer and mark it the active one. */
async function upsertServer(c: ConnConfig): Promise<SavedServer> {
  const list = await readServerList()
  const now = Date.now()
  // The machine's identity is the TOKEN, not the address: many machines sit
  // behind one host (the official relay routes by token), so keying entries
  // by host+tls made scanning a second computer silently hijack the first
  // entry's token — one flip-flopping entry instead of two machines.
  // Re-scanning the SAME machine refreshes its entry; a different token on
  // the same address is a different machine and gets its own entry.
  const candidates = list.filter((s) => s.host === c.host && s.tls === c.tls)
  for (const srv of candidates) {
    const saved = await readTokenFor(srv.id)
    if (saved === c.token) {
      srv.lastUsedAt = now
      await writeServerList(list)
      try { await AsyncStorage.setItem(ACTIVE_SERVER_KEY, srv.id) } catch {}
      activeServerId.set(srv.id)
      return srv
    }
  }
  let name = (c.name || c.host).trim() || c.host
  const taken = new Set(list.map((s) => s.name))
  if (taken.has(name)) {
    let i = 2
    while (taken.has(`${name} ${i}`)) i++
    name = `${name} ${i}`
  }
  const srv: SavedServer = { id: newServerId(), name, host: c.host, tls: c.tls, addedAt: now, lastUsedAt: now }
  list.push(srv)
  await writeTokenFor(srv.id, c.token)
  await writeServerList(list)
  try { await AsyncStorage.setItem(ACTIVE_SERVER_KEY, srv.id) } catch {}
  activeServerId.set(srv.id)
  return srv
}

/** Most recently used saved computer (new list first). */
export function mostRecentServer(list?: SavedServer[]): SavedServer | null {
  const sorted = (list ?? servers.get()).slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  return sorted[0] ?? null
}

/** Connect to a remembered computer. Switches the active connection. */
export async function switchToServer(id: string): Promise<void> {
  const list = await readServerList()
  const srv = list.find((s) => s.id === id)
  if (!srv) throw new Error('This computer is no longer saved.')
  const token = await readTokenFor(srv.id)
  if (!token) throw new Error('No saved token for this computer — pair again.')
  await connect({ host: srv.host, token, tls: srv.tls })
}

/** Remove one remembered computer. Forgets the active connection if it was ours. */
export async function removeServer(id: string): Promise<SavedServer[]> {
  const list = (await readServerList()).filter((s) => s.id !== id)
  await writeServerList(list)
  await deleteTokenFor(id)
  if (activeServerId.get() === id) {
    activeServerId.set(null)
    try { await AsyncStorage.removeItem(ACTIVE_SERVER_KEY) } catch {}
    await clearConfig()
  }
  return list
}

/**
 * Forget the computer we are currently connected to (others survive).
 * Returns the remaining list so the caller can auto-switch to another.
 */
export async function forgetActiveServer(): Promise<SavedServer[]> {
  const cfg = connConfig.get()
  const list = await readServerList()
  const id = activeServerId.get()
    ?? (cfg ? list.find((s) => s.host === cfg.host && s.tls === cfg.tls)?.id : undefined)
  if (id) return removeServer(id)
  await clearConfig()
  return refreshServers()
}

export async function loadSavedConfig(): Promise<ConnConfig | null> {
  try {
    // Migrate legacy plaintext bundle once
    const legacy = await AsyncStorage.getItem(LEGACY_KEY)
    if (legacy) {
      try {
        const c = JSON.parse(legacy) as ConnConfig
        if (c?.host && c?.token) {
          await saveConfig({ host: c.host, token: c.token, tls: !!c.tls })
          log('info', 'auth', 'migrated legacy connection to SecureStore')
        }
      } catch {}
      await AsyncStorage.removeItem(LEGACY_KEY)
    }
    const loaded = await readStored()
    if (loaded) {
      connConfig.set(loaded)
      // Seed the remembered-computers list from pre–multi-server installs.
      const list = await readServerList()
      if (!list.length || !list.some((s) => s.host === loaded.host && s.tls === loaded.tls)) {
        try { await upsertServer(loaded) } catch (err) { log('warn', 'auth', `server-list seed failed: ${String(err)}`) }
      }
      // Reconcile: the config we are about to boot into is by definition the
      // latest/active computer — never let the pointer drift from it.
      const fresh = await readServerList()
      const active = fresh.find((s) => s.host === loaded.host && s.tls === loaded.tls)
      if (active && activeServerId.get() !== active.id) {
        activeServerId.set(active.id)
        try { await AsyncStorage.setItem(ACTIVE_SERVER_KEY, active.id) } catch {}
      }
    }
    await refreshServers()
    return loaded
  } catch (err) {
    log('error', 'auth', `loadSavedConfig failed: ${String(err)}`)
    return null
  }
}

async function readStored(): Promise<ConnConfig | null> {
  const [host, tlsRaw] = await Promise.all([
    AsyncStorage.getItem(HOST_KEY),
    AsyncStorage.getItem(TLS_KEY),
  ])
  if (!host) return null
  let token: string | null = null
  if (await secureAvailable()) {
    token = await SecureStore.getItemAsync(TOKEN_KEY)
  } else {
    token = await AsyncStorage.getItem(TOKEN_KEY)
  }
  if (!token) return null
  return { host, token, tls: tlsRaw === '1' }
}

export async function saveConfig(c: ConnConfig) {
  const v = validateConfig(c)
  await AsyncStorage.setItem(HOST_KEY, v.host)
  await AsyncStorage.setItem(TLS_KEY, v.tls ? '1' : '0')
  if (await secureAvailable()) {
    await SecureStore.setItemAsync(TOKEN_KEY, v.token)
  } else {
    log('warn', 'auth', 'SecureStore unavailable (web?) — token in AsyncStorage')
    await AsyncStorage.setItem(TOKEN_KEY, v.token)
  }
  connConfig.set(v)
}

export async function clearConfig() {
  cancelReconnect()
  wantConnection = false
  lastConfig = null
  try { await AsyncStorage.multiRemove([HOST_KEY, TLS_KEY, TOKEN_KEY, LEGACY_KEY]) } catch {}
  try { await SecureStore.deleteItemAsync(TOKEN_KEY) } catch {}
  connConfig.set(null)
  gatewayError.set(null)
}

function ensureClient(): JsonRpcGatewayClient {
  if (client) return client
  const cli = new JsonRpcGatewayClient({
    socketFactory: (url: string) => new RnWebSocketAdapter(url) as unknown as WebSocket,
    connectTimeoutMs: 12_000,
    requestTimeoutMs: 120_000,
    onRequestHandlerError: (err, req) => log('error', 'gateway', `server request ${req.method} handler crashed: ${String(err)}`),
    onUnhandledRequest: (req) => log('warn', 'gateway', `no handler for server request ${req.method} (${req.id}) — answered -32601`),
    onSocketClose: (ev) => {
      // Returning false lets the client transition to 'closed'; we schedule reconnect below.
      void ev
    },
  })
  stopEvents?.()
  stopState?.()
  stopRequests?.()
  stopEvents = cli.onAny((e) => {
    dispatch(e)
  })
  stopRequests = cli.onRequest((req) => dispatchRequest(req))
  stopState = cli.onState((s) => {
    connectionState.set(s)
    if (s === 'closed' || s === 'error') {
      scheduleReconnect()
    }
    if (s === 'open') {
      reconnectAttempt.set(0)
      gatewayError.set(null)
    }
  })
  client = cli
  return cli
}

function cancelReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
}

function scheduleReconnect() {
  if (!wantConnection || !lastConfig || manualClose) return
  if (reconnectTimer) return
  const attempt = reconnectAttempt.get() + 1
  reconnectAttempt.set(attempt)
  const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30_000)
  log('warn', 'gateway', `socket closed — retry #${attempt} in ${Math.round(delay / 1000)}s`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!wantConnection || manualClose || !lastConfig) return
    void dial(lastConfig, { isRetry: true }).catch(() => {})
  }, delay)
}

export async function retryNow(): Promise<void> {
  cancelReconnect()
  manualClose = false
  if (!lastConfig) {
    const saved = connConfig.get() ?? (await loadSavedConfig())
    if (!saved) throw new Error('No saved connection')
    lastConfig = saved
  }
  await dial(lastConfig, { isRetry: true })
}

// ---- push token re-advertisement ---------------------------------------------
// A token acquired MID-SESSION (the first-message ask, armPushOnFirstSend) is
// otherwise invisible to the machine until the NEXT dial: the socket is
// already open, so wsUrl() already ran without it. If the OEM freezes the
// process before a reconnect, the machine holds no token and every knock
// no-ops for the whole pocket session. Watching the token atom and re-dialing
// advertises &push= on the fresh upgrade request line, which the machine-side
// proxy captures. Deduped per token value — connect() no-ops for the same URL
// and cleanly supersedes a different one (the added query makes it different).
let readvertiseStarted = false
let lastAdvertisedToken: string | null = null
function ensureTokenReadvertise(): void {
  if (readvertiseStarted) return
  readvertiseStarted = true
  try {
    // Same lazy require as wsUrl(): plain-node suites import this module, and
    // push.ts drags in expo/react-native modules that cannot load outside the
    // app runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const push = require('./push') as typeof import('./push') | undefined
    push?.expoPushToken?.subscribe((tok) => {
      if (!tok || tok === lastAdvertisedToken) return
      lastAdvertisedToken = tok
      if (!wantConnection || !lastConfig) return // disconnected: the next dial advertises anyway
      void retryNow().catch(() => {})
    })
  } catch {}
}

async function dial(c: ConnConfig, opts?: { isRetry?: boolean }): Promise<void> {
  ensureTokenReadvertise() // idempotent: arms the mid-session token re-advertise once
  const gen = ++connectGen
  // Embedded gateway: always use the LIVE token from the runtime. A stored
  // token can go stale (e.g. app uninstall regenerated the token file while
  // SecureStore kept the old pairing) — that presented as "must forget and
  // re-pair after reinstall".
  if (isLocalHost(c.host)) {
    const gw = await getEmbeddedGateway().catch(() => null)
    if (gw?.token) c = { ...c, token: gw.token }
  }
  const v = validateConfig(c)
  wantConnection = true
  manualClose = false
  gatewayError.set(null)
  connectionState.set('connecting')
  // The config is validated — the identity point. Runs before the handshake
  // AND before the persist chain below, so a backend switch re-scopes the
  // caches before anything reads them.
  for (const hook of dialHooks) {
    try { await hook(v) } catch (err) { log('warn', 'gateway', `dial hook failed: ${String(err)}`) }
  }
  // Persistence runs CONCURRENTLY with the dial, not before it: the writes
  // are pure side effects for the handshake (the token rides the URL; the
  // connect path below reads none of what they write), so the reconnect tap
  // starts the WebSocket immediately. The computer is still remembered even
  // while unreachable, exactly as before — a saveConfig failure skips the
  // upsert just like the old early-abort did. Each dial awaits its tail on
  // the exits callers observe (throw / happy end); superseded early-returns
  // skip the await because whatever dial superseded us awaits a chain that
  // already contains our writes.
  const persist = (persistChain = persistChain.then(async () => {
    await saveConfig(v)
    // Remember this computer (even if it's unreachable right now — it should
    // still show up in the saved list once the phone can reach it again).
    try { await upsertServer(v) } catch (err) { log('warn', 'auth', `remember computer failed: ${String(err)}`) }
  }).catch((err) => { log('warn', 'auth', `save connection failed: ${String(err)}`) }))

  if (!v.tls && !isLocalHost(v.host)) {
    log('warn', 'gateway', 'plain ws:// to non-local host — token travels unencrypted')
  }

  const cli = ensureClient()
  const url = wsUrl(v)
  log('info', 'gateway', `connecting ${redactedUrl(v)}${opts?.isRetry ? ' (retry)' : ''}`)

  let ready = false
  const stopReady = cli.onAny((e) => {
    if (e.type === 'gateway.ready') ready = true
  })
  try {
    await cli.connect(url)
  } catch (err) {
    stopReady()
    if (gen !== connectGen) return // superseded by newer dial
    connectionState.set('error')
    const msg = err instanceof Error ? err.message : 'Connection failed'
    gatewayError.set(`${redactedUrl(v)} — ${msg}`)
    log('error', 'gateway', `connect failed: ${msg}`)
    scheduleReconnect()
    await persist
    throw err
  }
  if (gen !== connectGen) { stopReady(); return }

  // Wait briefly for gateway.ready; do NOT declare open-false-positive —
  // the socket-level client already set state to 'open'. If ready never
  // arrives we stay connected but warn (auth failures surface as RPC errors).
  await new Promise<void>((resolve) => {
    if (ready) return resolve()
    const t = setTimeout(resolve, 3000)
    const stop = cli.onAny((e) => {
      if (e.type === 'gateway.ready') { clearTimeout(t); stop(); resolve() }
    })
    setTimeout(() => { try { stop() } catch {} }, 3500)
  })
  stopReady()
  if (gen !== connectGen) return
  reconnectAttempt.set(0)
  connectionState.set('open')
  log('info', 'gateway', `connected ${redactedUrl(v)}${ready ? '' : ' (no gateway.ready yet)'}`)
  await persist
}

export async function connect(c: ConnConfig): Promise<void> {
  cancelReconnect()
  await dial(c)
}

export function disconnect() {
  manualClose = true
  wantConnection = false
  cancelReconnect()
  connectGen++
  try { client?.close() } catch {}
  connectionState.set('idle')
}

/** Foreground resume — retry immediately if we were supposed to be connected. */
let foregroundProbeInFlight = false
export function onForeground() {
  if (!wantConnection || manualClose) return
  const st = connectionState.get()
  if (st !== 'open' && st !== 'connecting') {
    log('info', 'gateway', 'foreground resume — retrying')
    void retryNow().catch(() => {})
    return
  }
  // The state LOOKS open, but Android froze the process in the background and
  // the socket is usually half-dead by the time the user returns. Probe it
  // right now: waiting for the heartbeat cycle to notice costs up to 45s of
  // "reconnecting" on the next thing the user touches.
  if (foregroundProbeInFlight || !client) return
  foregroundProbeInFlight = true
  client
    .request('gateway.ping', {}, 2500)
    .catch(() => {
      if (connectionState.get() === 'open') {
        log('info', 'gateway', 'foreground probe found a dead socket — rebuilding')
        void retryNow().catch(() => {})
      }
    })
    .finally(() => { foregroundProbeInFlight = false })
}

export function getClient(): JsonRpcGatewayClient | null { return client }

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  if (!client) throw new Error('Not connected')
  if (timeoutMs !== undefined) return client.request<T>(method, params, timeoutMs)
  return client.request<T>(method, params)
}
