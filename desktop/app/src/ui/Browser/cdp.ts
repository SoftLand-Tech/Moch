// CDP transport for the Browser screen — the transport-glue exception the
// architecture allows under src/ui: one WebSocket to the shell's raw CDP
// proxy (the shell publishes its port on GET /cdp/ws-port), JSON-RPC id
// matching, event subscription. No Moch protocol lives here.

export type CdpTarget = {
  id: string
  title: string
  url: string
  type: string
}

export type TargetsResult =
  | { ok: true; targets: CdpTarget[] }
  | { ok: false; error: string }

type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void }
type EventHandler = (params: Record<string, unknown>) => void

const SEND_TIMEOUT_MS = 15_000

export class CdpSession {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, Set<EventHandler>>()
  private closedByUs = false

  constructor(readonly wsUrl: string) {}

  connect(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    this.closedByUs = false
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('cdp websocket failed — proxy or agent browser down'))
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.failPending(
        new Error(this.closedByUs ? 'cdp session closed' : 'cdp websocket closed unexpectedly'),
      )
      this.emit('_closed', {})
    }
    return promise
  }

  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('cdp session not open'))
    }
    const id = this.nextId++
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new Error(`cdp ${method} timed out`))
    }, SEND_TIMEOUT_MS)
    this.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v as T)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    return promise
  }

  /** Subscribe to a CDP event; `_closed` fires once when the socket dies. */
  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  close(): void {
    this.closedByUs = true
    const ws = this.ws
    this.ws = null
    this.failPending(new Error('cdp session closed'))
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.close(1000, 'screen closed')
    }
  }

  private onMessage(raw: unknown): void {
    let msg: {
      id?: number
      result?: unknown
      error?: { message?: string }
      method?: string
      params?: Record<string, unknown>
    }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? `cdp error ${msg.id}`))
      else p.resolve(msg.result ?? {})
      return
    }
    if (typeof msg.method === 'string') this.emit(msg.method, msg.params ?? {})
  }

  private emit(event: string, params: Record<string, unknown>): void {
    const set = this.handlers.get(event)
    if (set) for (const h of [...set]) h(params)
  }

  private failPending(error: Error): void {
    for (const p of [...this.pending.values()]) p.reject(error)
    this.pending.clear()
  }
}

let wsPortCache: number | null | undefined

export async function fetchCdpWsPort(): Promise<number | null> {
  if (wsPortCache !== undefined) return wsPortCache
  try {
    const res = await fetch('/cdp/ws-port')
    const body: unknown = await res.json()
    wsPortCache = null
    if (body && typeof body === 'object' && 'port' in body) {
      const port: unknown = body.port
      if (typeof port === 'number') wsPortCache = port
    }
  } catch {
    wsPortCache = null
  }
  return wsPortCache
}

export async function fetchTargets(): Promise<TargetsResult> {
  let res: Response
  try {
    res = await fetch('/cdp/json')
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'cdp unreachable' }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, error: `cdp /json returned ${res.status} with a non-JSON body` }
  }
  if (!res.ok) {
    let reason: unknown
    if (body && typeof body === 'object' && 'error' in body) reason = body.error
    return {
      ok: false,
      error: typeof reason === 'string' ? reason : `cdp /json returned ${res.status}`,
    }
  }
  if (!Array.isArray(body)) return { ok: false, error: 'cdp /json returned a malformed target list' }
  const targets: CdpTarget[] = []
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue
    if (!('id' in entry) || !('type' in entry)) continue
    const id: unknown = entry.id
    const type: unknown = entry.type
    if (typeof id !== 'string' || typeof type !== 'string') continue
    const title = 'title' in entry && typeof entry.title === 'string' ? entry.title : ''
    const url = 'url' in entry && typeof entry.url === 'string' ? entry.url : ''
    targets.push({ id, type, title, url })
  }
  return { ok: true, targets }
}
