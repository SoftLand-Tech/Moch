/**
 * cdp.ts — a compact Chrome DevTools Protocol client for the app-managed
 * headless Chromium (launched by the Rust side with --remote-debugging-port).
 * The UI uses it for two things:
 *
 *   1. the BrowserPane screencast (Page.startScreencast + Input forwarding),
 *   2. tab bookkeeping (/json endpoints + the Target domain) for the tab list.
 *
 * It also *arms* hermes: once per browser run we point the gateway's browser
 * tools at this Chromium (rpc moch.desktop.browser_cdp) so the user and the
 * agents share one browser — whatever hermes does shows up in the pane live.
 *
 * Connection model: one browser-level WebSocket (webSocketDebuggerUrl from
 * /json/version), flattened per-target sessions via Target.attachToTarget.
 * Commands sent while the socket is still opening are queued and flushed on
 * open, so callers never need to race the handshake. A dropped socket
 * reconnects with jittered backoff until the watcher says the browser stopped.
 */
import { atom } from 'nanostores'
import { invoke, listen } from './tauri'
import { rpc } from './gateway'

// ── CDP HTTP proxy ─────────────────────────────────────────────────────
// Chromium's DevTools HTTP server (/json/*) sends no CORS headers, so a web
// page can never fetch it directly — the calls go through the Tauri shell
// (cdp_fetch command) in the app, or the vite dev-bridge in the preview.

async function cdpHttpGet<T>(port: number, path: string, method: 'GET' | 'PUT' = 'GET'): Promise<T> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const raw = await invoke<string>('cdp_fetch', { port, path, method })
    return JSON.parse(raw) as T
  }
  const res = await fetch(`/dev-bridge/cdp?port=${port}&method=${method}&path=${encodeURIComponent(path)}`)
  if (!res.ok) throw new Error(`cdp proxy → HTTP ${res.status}`)
  const text = await res.text()
  return JSON.parse(text) as T
}

// ── shared state ─────────────────────────────────────────────────────

export interface BrowserStatus {
  running: boolean
  port: number | null
  executable: string | null
  profile_dir?: string | null
}

export interface CdpTab {
  id: string
  title: string
  url: string
  type: string
}

export type CdpConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected'

/** Managed-Chromium status from the Tauri shell (polled + pushed). */
export const browserStatus = atom<BrowserStatus>({ running: false, port: null, executable: null })
/** Browser-level WebSocket state — screencast panes (re)attach when it flips to 'connected'. */
export const cdpConnection = atom<CdpConnectionState>('idle')
/** Page-type targets from /json/list, refreshed on a slow loop. */
export const browserTabs = atom<CdpTab[]>([])
/** Which target the pane is showing; set by the tab list or the first tab seen. */
export const activeTargetId = atom<string | null>(null)

// ── the client ───────────────────────────────────────────────────────

/** Event handlers receive the raw CDP params plus the flattened session id. */
export type CdpEventHandler = (params: any, sessionId?: string) => void

const SEND_TIMEOUT_MS = 10_000
const OPEN_TIMEOUT_MS = 8_000

interface QueuedSend {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { message?: string; code?: number }
}

interface CdpVersion {
  Browser?: string
  webSocketDebuggerUrl: string
}

/** /json/list rows (unfiltered — includes workers, iframes, …). */
interface RawTarget {
  id: string
  title?: string
  url?: string
  type?: string
  parentId?: string
}

export class CdpClient {
  private port = 0
  private ws: WebSocket | null = null
  private msgId = 0
  private readonly pending = new Map<number, QueuedSend>()
  private readonly outbox: QueuedSend[] = []
  private readonly handlers = new Map<string, Set<CdpEventHandler>>()
  private wantConnected = false
  private dialGen = 0
  private dialing: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0

  getPort(): number {
    return this.port
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /** Connect to the browser endpoint on `port`. Safe to call repeatedly. */
  async connect(port: number): Promise<void> {
    this.wantConnected = true
    if (this.port !== port) {
      this.port = port
      this.dialGen++
      this.resetSocket('superseded by a new browser port')
    }
    await this.dial()
  }

  /** Stop the socket and any reconnect attempts (browser stopped / unmount). */
  disconnect(): void {
    this.wantConnected = false
    this.dialGen++
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.resetSocket('disconnected')
    cdpConnection.set('idle')
  }

  /**
   * Send a CDP command. If the socket is still opening (or briefly down with
   * a reconnect pending) the command is queued and flushed on open — each
   * call still times out after 10s so callers can't hang forever.
   */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const q: QueuedSend = {
        id: 0,
        method,
        params,
        sessionId,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
      }
      this.armTimeout(q)
      const ws = this.ws
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.transmit(q, ws)
        return
      }
      if (!this.wantConnected) {
        this.failQueued(q, new Error('cdp: not connected'))
        return
      }
      this.outbox.push(q)
    })
  }

  /** Subscribe to a CDP event by method name. Returns an unsubscribe fn. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(method)
    }
  }

  /** Flatten-attach to a page target; commands then go with the returned sessionId. */
  async attachToPage(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    return sessionId
  }

  // — HTTP endpoints (loopback via the shell proxy — Chromium's DevTools HTTP
  //   server sends no CORS headers, so a page can never fetch it directly) —

  async listTabs(): Promise<CdpTab[]> {
    const raw = await cdpHttpGet<RawTarget[]>(this.port, '/json/list')
    return raw
      .filter((t) => t.type === 'page' && !t.parentId)
      .map((t) => ({ id: t.id, title: t.title ?? '', url: t.url ?? '', type: t.type ?? 'page' }))
  }

  async newTab(url: string): Promise<CdpTab> {
    const raw = await cdpHttpGet<RawTarget | RawTarget[]>(this.port, `/json/new?url=${encodeURIComponent(url)}`, 'PUT')
    const t = Array.isArray(raw) ? raw.find((x) => x.type === 'page') ?? raw[0] : raw
    return { id: t.id, title: t.title ?? '', url: t.url ?? '', type: t.type ?? 'page' }
  }

  async closeTab(id: string): Promise<void> {
    // /json/close answers plain text; a non-2xx would throw in the proxy.
    await cdpHttpGet<unknown>(this.port, `/json/close/${id}`)
  }

  // — internals —

  private async fetchJson<T>(path: string): Promise<T> {
    return cdpHttpGet<T>(this.port, path)
  }

  private async dial(): Promise<void> {
    if (this.isConnected()) return
    if (this.dialing) return this.dialing
    const p = this.dialOnce().finally(() => {
      if (this.dialing === p) this.dialing = null
    })
    this.dialing = p
    return p
  }

  private async dialOnce(): Promise<void> {
    const gen = this.dialGen
    cdpConnection.set('connecting')
    let wsUrl: string
    try {
      const version = await this.fetchJson<CdpVersion>('/json/version')
      wsUrl = version.webSocketDebuggerUrl
    } catch (err) {
      if (gen === this.dialGen) {
        cdpConnection.set('disconnected')
        this.scheduleReconnect()
      }
      throw err
    }
    if (gen !== this.dialGen) throw new Error('cdp: stale dial')

    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(wsUrl)
      } catch (err) {
        reject(err)
        return
      }
      this.ws = ws
      const timer = setTimeout(() => {
        cleanup()
        if (this.ws !== ws) {
          reject(new Error('cdp: websocket open timed out'))
          return
        }
        this.ws = null
        ws.onclose = null
        try { ws.close() } catch { /* already closed */ }
        if (gen === this.dialGen) this.handleDisconnect()
        reject(new Error('cdp: websocket open timed out'))
      }, OPEN_TIMEOUT_MS)
      const cleanup = () => clearTimeout(timer)
      ws.onopen = () => {
        cleanup()
        if (this.ws !== ws) return
        this.reconnectAttempt = 0
        cdpConnection.set('connected')
        this.flushOutbox()
        resolve()
      }
      ws.onmessage = (ev: MessageEvent) => {
        if (this.ws === ws) this.handleMessage(String(ev.data))
      }
      ws.onclose = () => {
        cleanup()
        if (this.ws !== ws) return
        this.ws = null
        if (gen === this.dialGen) this.handleDisconnect()
        reject(new Error('cdp: websocket closed before opening'))
      }
      ws.onerror = () => { /* onclose follows */ }
    })
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || this.reconnectTimer) return
    const attempt = ++this.reconnectAttempt
    const base = Math.min(500 * 2 ** Math.min(attempt - 1, 5), 8_000)
    const delay = Math.round(base * (0.7 + Math.random() * 0.6))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.wantConnected) return
      void this.dial().catch(() => { /* retried by the next tick */ })
    }, delay)
  }

  private handleDisconnect(): void {
    this.resetSocket('connection lost')
    cdpConnection.set('disconnected')
    this.scheduleReconnect()
  }

  private resetSocket(reason: string): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      try { ws.close() } catch { /* already closed */ }
    }
    for (const q of this.outbox.splice(0)) this.failQueued(q, new Error(`cdp: ${reason}`))
    for (const q of this.pending.values()) this.failQueued(q, new Error(`cdp: ${reason}`))
    this.pending.clear()
  }

  private flushOutbox(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || this.outbox.length === 0) return
    for (const q of this.outbox.splice(0)) this.transmit(q, ws)
  }

  private transmit(q: QueuedSend, ws: WebSocket): void {
    q.id = ++this.msgId
    this.pending.set(q.id, q)
    this.armTimeout(q) // restart the 10s clock at transmit time
    const msg: Record<string, unknown> = { id: q.id, method: q.method, params: q.params }
    if (q.sessionId) msg.sessionId = q.sessionId
    ws.send(JSON.stringify(msg))
  }

  private armTimeout(q: QueuedSend): void {
    if (q.timer) clearTimeout(q.timer)
    q.timer = setTimeout(() => {
      if (q.id) this.pending.delete(q.id)
      else {
        const i = this.outbox.indexOf(q)
        if (i >= 0) this.outbox.splice(i, 1)
      }
      q.timer = null
      q.reject(new Error(`cdp: ${q.method} timed out`))
    }, SEND_TIMEOUT_MS)
  }

  private failQueued(q: QueuedSend, err: Error): void {
    if (q.timer) {
      clearTimeout(q.timer)
      q.timer = null
    }
    q.reject(err)
  }

  private handleMessage(raw: string): void {
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const q = this.pending.get(msg.id)
      if (!q) return
      this.pending.delete(msg.id)
      if (q.timer) {
        clearTimeout(q.timer)
        q.timer = null
      }
      if (msg.error) q.reject(new Error(`cdp: ${q.method} → ${msg.error.message ?? `error ${msg.error.code ?? '?'}`}`))
      else q.resolve(msg.result)
      return
    }
    if (!msg.method) return
    const set = this.handlers.get(msg.method)
    if (!set || set.size === 0) return
    for (const h of [...set]) {
      try {
        h(msg.params ?? {}, msg.sessionId)
      } catch (err) {
        console.warn(`[cdp] ${msg.method} handler threw`, err)
      }
    }
  }
}

let singleton: CdpClient | null = null

/** The app-wide CDP client (one browser-level ws, shared by every pane). */
export function getCdp(): CdpClient {
  if (!singleton) singleton = new CdpClient()
  return singleton
}

// ── lifecycle: status watch, tab refresh, agent arming ───────────────

let watchStarted = false

/**
 * Start the app-wide browser watcher: polls browser_status (and listens to
 * the shell's browser://status pushes), connects the client whenever a
 * Chromium is up, keeps the tab list fresh, and arms/disarms hermes.
 * Idempotent; the first mounted BrowserPane starts it.
 */
export function ensureBrowserWatch(): void {
  if (watchStarted) return
  watchStarted = true
  void refreshBrowserStatus()
  setInterval(() => {
    void refreshBrowserStatus()
    void refreshTabs()
  }, 3_000)
  void listen<BrowserStatus>('browser://status', (e) => applyStatus(e.payload)).catch(() => {
    /* not under Tauri (plain-browser dev) — polling covers us */
  })
}

export async function refreshBrowserStatus(): Promise<BrowserStatus> {
  let st: BrowserStatus
  try {
    st = await invoke<BrowserStatus>('browser_status')
  } catch {
    return browserStatus.get()
  }
  applyStatus(st)
  return st
}

export async function launchBrowser(): Promise<BrowserStatus> {
  const st = await invoke<BrowserStatus>('browser_launch')
  applyStatus(st)
  void refreshTabs()
  return st
}

export async function stopBrowser(): Promise<void> {
  try {
    await invoke('browser_stop')
  } finally {
    applyStatus({ running: false, port: null, executable: browserStatus.get().executable })
  }
}

function applyStatus(st: BrowserStatus): void {
  browserStatus.set(st)
  const cdp = getCdp()
  if (st.running && st.port != null) {
    void armAgent(st.port)
    if (!cdp.isConnected() && cdp.getPort() !== st.port) {
      void cdp.connect(st.port).catch(() => { /* the watcher retries on later ticks */ })
    }
  } else {
    void disarmAgent()
    cdp.disconnect()
    browserTabs.set([])
    activeTargetId.set(null)
  }
}

/** Poll /json/list into the atom; also repairs a stale active target. */
export async function refreshTabs(): Promise<CdpTab[]> {
  const cdp = getCdp()
  if (!cdp.isConnected()) return browserTabs.get()
  try {
    const tabs = await cdp.listTabs()
    browserTabs.set(tabs)
    const active = activeTargetId.get()
    if (tabs.length === 0) {
      if (active !== null) activeTargetId.set(null)
    } else if (!active || !tabs.some((t) => t.id === active)) {
      activeTargetId.set(tabs[0].id)
    }
    return tabs
  } catch {
    return browserTabs.get()
  }
}

// ── arming hermes' browser tools ─────────────────────────────────────

let armedKey: string | null = null
let lastArmAttempt = 0
const ARM_RETRY_MS = 5_000

/**
 * Point hermes' browser tools at this Chromium — once per run. Retries
 * (throttled) while the gateway is offline, and disarms ({url: ''}) when the
 * browser stops so a relaunch on the same port counts as a new run.
 */
async function armAgent(port: number): Promise<void> {
  const key = String(port)
  if (armedKey === key) return
  const now = Date.now()
  if (now - lastArmAttempt < ARM_RETRY_MS) return
  lastArmAttempt = now
  try {
    await rpc('moch.desktop.browser_cdp', { url: `http://127.0.0.1:${port}` })
    armedKey = key
  } catch {
    /* gateway offline — retried on a later status tick */
  }
}

async function disarmAgent(): Promise<void> {
  if (armedKey === null) return
  armedKey = null
  try {
    await rpc('moch.desktop.browser_cdp', { url: '' })
  } catch {
    /* swallow — the browser is gone either way */
  }
}
