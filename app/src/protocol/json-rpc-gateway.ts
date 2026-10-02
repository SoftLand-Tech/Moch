/**
 * WebSocket half of a Hermes gateway connection: socket lifecycle + the
 * lossless event replay contract, on top of `JsonRpcRequestChannel`.
 *
 * Ported from the upstream shared client:
 *   ~/.hermes/hermes-agent/apps/shared/src/json-rpc-gateway.ts
 * Contract: ~/.hermes/hermes-agent/apps/shared/src/gateway-contract.generated.ts
 */

import {
  DEFAULT_HEARTBEAT_DEADLINE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  type GatewayEvent,
  type GatewayRequestId,
  JsonRpcRequestChannel,
  type JsonRpcRequestChannelOptions,
  type JsonRpcTransport,
  type ServerRequestHandler,
  wireFrameText,
} from './json-rpc-channel'

export {
  JsonRpcGatewayError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  jsonRpcErrorFromFrame,
  wireFrameText,
} from './json-rpc-channel'
export type { GatewayEvent, GatewayRequestId, ServerRequest, ServerRequestHandler, ServerRequestParams } from './json-rpc-channel'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'
export type WebSocketLike = WebSocket

export interface GatewayClientOptions {
  closedErrorMessage?: string
  connectErrorMessage?: string
  connectTimeoutMs?: number
  createRequestId?: (nextId: number) => GatewayRequestId
  heartbeatDeadlineMs?: number
  heartbeatIntervalMs?: number
  notConnectedErrorMessage?: string
  onRequestHandlerError?: JsonRpcRequestChannelOptions['onRequestHandlerError']
  onSocketClose?: (event: { code: number; reason?: string }) => boolean | void
  onUnhandledRequest?: JsonRpcRequestChannelOptions['onUnhandledRequest']
  replay?: boolean
  requestIdPrefix?: string
  requestTimeoutMs?: number
  socketFactory?: (url: string) => WebSocketLike
}

const ANY = '*'
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const REPLAY_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

const isGatewayReady = (e: GatewayEvent): e is GatewayEvent => e.type === 'gateway.ready'

/** True for a `ws://` / `wss://` URL string — the only thing `connect()` will dial. */
export function isGatewayWebSocketUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const protocol = new URL(value).protocol
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

/** Typed fan-out of gateway `event` notifications: per-type handlers plus a `*` wildcard. */
export class GatewayEventHub {
  private readonly handlers = new Map<string, Set<(event: GatewayEvent) => void>>()

  on(type: string, handler: (event: GatewayEvent) => void): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  onAny(handler: (event: GatewayEvent) => void): () => void {
    return this.on(ANY, handler)
  }

  dispatch(event: GatewayEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event)
    for (const handler of this.handlers.get(ANY) ?? []) handler(event)
  }
}

const socketTransport = (socket: WebSocketLike): JsonRpcTransport => ({ send: text => socket.send(text) })

export class JsonRpcGatewayClient {
  private socket: WebSocketLike | null = null
  /** URL of the socket in `this.socket`, '' when none — connect() compares it
   *  to tell an idempotent re-dial from a switch to a different gateway. */
  private socketUrl = ''
  private state: ConnectionState = 'idle'
  private readonly channel: JsonRpcRequestChannel
  private readonly events = new GatewayEventHub()
  /** Last observed event seq per session_id — drives lossless reconnect replay. */
  private lastSeenSeq = new Map<string, number>()
  private replayInFlight = false
  /** Invalidates an interrupted replay so its cleanup cannot own a replacement socket. */
  private replayGeneration = 0
  /**
   * While a replay fetch is in flight, live seq'd frames for the sessions being
   * replayed are parked here instead of dispatching immediately. Without this
   * hold, a live frame racing the replay response is dispatched twice, or
   * advances the watermark so the gap events the replay carries get skipped.
   */
  private replayHold: Map<string, GatewayEvent[]> | null = null
  /**
   * Server process identity for the replay contract. Seq counters are
   * in-process on the backend, so a restart resets them while we still hold
   * high watermarks.
   */
  private replayEpoch: string | null = null
  private readonly stateHandlers = new Set<(state: ConnectionState) => void>()
  private readonly options: Required<
    Omit<GatewayClientOptions, 'onRequestHandlerError' | 'onUnhandledRequest' | 'socketFactory'>
  > &
    Pick<GatewayClientOptions, 'onRequestHandlerError' | 'onUnhandledRequest' | 'socketFactory'>

  constructor(options: GatewayClientOptions = {}) {
    this.options = {
      closedErrorMessage: options.closedErrorMessage ?? 'WebSocket closed',
      connectErrorMessage: options.connectErrorMessage ?? 'WebSocket connection failed',
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      createRequestId: options.createRequestId ?? ((nextId: number) => `${options.requestIdPrefix ?? 'r'}${nextId}`),
      heartbeatDeadlineMs: options.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      notConnectedErrorMessage: options.notConnectedErrorMessage ?? 'gateway not connected',
      onSocketClose: options.onSocketClose ?? (() => false),
      replay: options.replay ?? true,
      requestIdPrefix: options.requestIdPrefix ?? 'r',
      onRequestHandlerError: options.onRequestHandlerError,
      onUnhandledRequest: options.onUnhandledRequest,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      socketFactory: options.socketFactory,
    }
    this.channel = new JsonRpcRequestChannel({
      createRequestId: this.options.createRequestId,
      heartbeatDeadlineMs: this.options.heartbeatDeadlineMs,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      heartbeatLiveness: 'any-inbound',
      notConnectedErrorMessage: this.options.notConnectedErrorMessage,
      onEvent: event => this.handleEvent(event),
      onHeartbeatFailure: error => this.invalidate(error.message),
      onRequestHandlerError: this.options.onRequestHandlerError,
      onUnhandledRequest: this.options.onUnhandledRequest,
      requestTimeoutMs: this.options.requestTimeoutMs,
    })
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  async connect(wsUrl: string): Promise<void> {
    const invalidUrl = () => {
      const got = typeof wsUrl === 'string' ? JSON.stringify(wsUrl) : `type "${typeof wsUrl}"`
      return new Error(`gateway connect() requires a ws:// or wss:// URL string, got ${got}`)
    }

    if (!isGatewayWebSocketUrl(wsUrl)) throw invalidUrl()
    // Idempotent for the SAME endpoint: reconnect taps and double-connects
    // must not bounce a healthy socket. A DIFFERENT URL must never be
    // silently ignored just because some socket happens to be open — that
    // no-op kept the phone on the first machine when pairing a second one
    // behind the same relay host.
    if (wsUrl === this.socketUrl && ((this.socket && this.socket.readyState === WebSocket.OPEN) || this.state === 'connecting')) return
    if (this.socket || this.state === 'connecting') {
      const stale = this.socket
      this.dropSocket(new Error('superseded by a connect to a different gateway'))
      try { stale?.close() } catch {}
    }
    this.socketUrl = wsUrl

    this.setState('connecting')

    const socket = this.options.socketFactory?.(wsUrl) ?? new WebSocket(wsUrl)
    const transport = socketTransport(socket)
    this.socket = socket
    this.channel.stopHeartbeat()

    socket.addEventListener('message', message => {
      if (this.socket !== socket) return
      const text = wireFrameText((message as MessageEvent).data)
      if (text !== null) this.channel.handleFrame(text)
    })

    socket.addEventListener('close', event => {
      if (this.socket !== socket) return
      if (this.options.onSocketClose(event as CloseEvent)) return
      this.dropSocket(new Error(this.options.closedErrorMessage))
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
      }

      const onOpen = () => {
        if (settled || this.socket !== socket) return
        settled = true
        cleanup()
        this.channel.attach(transport)
        this.setState('open')
        resolve()
        void this.fetchReplay()
      }

      const onError = () => {
        if (settled || this.socket !== socket) return
        settled = true
        cleanup()
        this.setState('error')
        reject(this.connectFailure('WebSocket error before open'))
      }

      // A server that closes during the handshake (auth gate 4401/4403) may
      // never fire `error`; without this the caller waits out the connect
      // timeout for a verdict the socket already delivered.
      const onClose = (event: Event) => {
        if (settled) return
        settled = true
        cleanup()
        const code = (event as CloseEvent).code
        if (this.socket === socket) {
          this.socket = null
          this.setState('error')
        }
        reject(this.connectFailure(`WebSocket closed during handshake: code ${code}`))
      }

      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      socket.addEventListener('close', onClose, { once: true })

      if (this.options.connectTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          if (this.socket === socket) {
            try {
              socket.close()
            } catch {
              /* already gone */
            }
            this.socket = null
            this.setState('error')
          }
          reject(this.connectFailure(`no WebSocket open within ${this.options.connectTimeoutMs} ms`))
        }, this.options.connectTimeoutMs)
      }
    })
  }

  private connectFailure(detail: string): Error {
    return new Error(`${this.options.connectErrorMessage} (${detail})`)
  }

  close(): void {
    this.invalidate()
  }

  /** Invalidate the current socket generation after an ambiguous transport outcome. */
  invalidate(message = this.options.closedErrorMessage): void {
    const socket = this.socket
    if (!socket) return
    // Drop the generation BEFORE closing so a synchronous `close` event hits
    // the identity guard instead of running the default closed-path twice.
    this.dropSocket(new Error(message))
    try {
      socket.close()
    } catch {
      /* already invalidated */
    }
  }

  on(type: string, handler: (event: GatewayEvent) => void): () => void {
    return this.events.on(type, handler)
  }

  onAny(handler: (event: GatewayEvent) => void): () => void {
    return this.events.onAny(handler)
  }

  onEvent(handler: (event: GatewayEvent) => void): () => void {
    return this.events.onAny(handler)
  }

  /**
   * Server->client requests (clarify, approval, sudo, secret, ...). Live
   * frames and `open_requests` re-delivered after a reconnect both arrive
   * here; the latter carry `replayed: true`.
   */
  onRequest(handler: ServerRequestHandler): () => void {
    return this.channel.onRequest(handler)
  }

  /**
   * Answer a server->client request by sending a response frame with the same
   * `srq-…` id on the socket that owns it.
   */
  respondServerRequest(id: string, result: Record<string, unknown>): void {
    this.channel.respondServerRequest(id, result)
  }

  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler)
    handler(this.state)
    return () => this.stateHandlers.delete(handler)
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.options.requestTimeoutMs, signal?: AbortSignal): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(this.options.notConnectedErrorMessage))
    }
    return this.channel.request<T>(method, params, timeoutMs, signal, () => new Error(this.options.notConnectedErrorMessage))
  }

  private handleEvent(event: GatewayEvent): void {
    if (isGatewayReady(event)) {
      if ((event.payload as { heartbeat?: unknown } | undefined)?.heartbeat === true) {
        this.channel.startHeartbeat()
      }
      const epoch = (event.payload as { replay_epoch?: unknown } | undefined)?.replay_epoch
      if (typeof epoch === 'string' && epoch) this.adoptReplayEpoch(epoch)
    }

    const sid = event.session_id
    const seqValue = event.seq

    if (this.replayHold && sid && typeof seqValue === 'number' && this.replayHold.has(sid)) {
      this.replayHold.get(sid)?.push(event)
      return
    }

    this.recordSeq(event)
    this.dispatchEvent(event)
  }

  private recordSeq(event: GatewayEvent): void {
    const sid = event.session_id
    const seq = event.seq
    if (!sid || typeof seq !== 'number' || !Number.isFinite(seq)) return
    const prev = this.lastSeenSeq.get(sid) ?? 0
    if (seq > prev) this.lastSeenSeq.set(sid, seq)
  }

  getSeqWatermarks(): Record<string, number> {
    return Object.fromEntries(this.lastSeenSeq)
  }

  /**
   * After a reconnect, replay every event newer than our per-session
   * watermarks. Best-effort: failures are swallowed (the next reconnect retries).
   */
  private async fetchReplay(): Promise<void> {
    if (!this.options.replay || this.replayInFlight || this.lastSeenSeq.size === 0) return

    this.replayInFlight = true
    const replayGeneration = ++this.replayGeneration
    const hold = new Map<string, GatewayEvent[]>()
    for (const sid of this.lastSeenSeq.keys()) hold.set(sid, [])
    this.replayHold = hold

    try {
      const entries = Object.entries(this.getSeqWatermarks())
      const results = await Promise.allSettled(
        entries.map(([sid, lastSeen]) =>
          this.request<{ events?: Array<{ type: string; session_id?: string; seq?: number; payload?: unknown }> }>(
            'session.events.since',
            { session_id: sid, last_seen: lastSeen },
            REPLAY_REQUEST_TIMEOUT_MS,
          ),
        ),
      )

      // The socket that owned this replay was dropped while its requests were
      // settling. Its results must not consume the replacement's window.
      if (this.replayGeneration !== replayGeneration) return

      for (const result of results) {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value?.events)) continue

        const epoch = (result.value as { epoch?: unknown }).epoch
        if (typeof epoch === 'string' && epoch && this.replayEpoch && epoch !== this.replayEpoch) {
          this.adoptReplayEpoch(epoch)
          continue
        }
        if (typeof epoch === 'string' && epoch && !this.replayEpoch) this.replayEpoch = epoch

        for (const event of result.value.events) {
          if (event?.type) this.dispatchIfNewer(event as GatewayEvent)
        }
      }
    } catch {
      // Replay is an optimization over lossy-reconnect; never surface errors.
    } finally {
      if (this.replayGeneration === replayGeneration) {
        this.flushReplayHold()
        this.replayInFlight = false
      }
    }
  }

  /** Dispatch an event only when its seq advances the session watermark. */
  private dispatchIfNewer(event: GatewayEvent): void {
    const sid = event.session_id
    const seq = event.seq
    if (sid && typeof seq === 'number' && Number.isFinite(seq)) {
      const prev = this.lastSeenSeq.get(sid) ?? 0
      if (seq <= prev) return
      this.lastSeenSeq.set(sid, seq)
    }
    this.dispatchEvent(event)
  }

  /** On a backend restart the old seq numbering no longer exists — drop the watermarks. */
  private adoptReplayEpoch(epoch: string): void {
    if (this.replayEpoch === epoch) return
    if (this.replayEpoch !== null) this.lastSeenSeq.clear()
    this.replayEpoch = epoch
  }

  private flushReplayHold(): void {
    const hold = this.replayHold
    this.replayHold = null
    if (!hold) return
    for (const parked of hold.values()) for (const event of parked) this.dispatchIfNewer(event)
  }

  /** Forget the current socket generation, fail its calls, and go 'closed'. */
  private dropSocket(error: Error): void {
    this.replayGeneration += 1
    this.replayInFlight = false
    this.replayHold = null
    this.socket = null
    this.socketUrl = ''
    this.channel.detach(error)
    this.setState('closed')
  }

  private dispatchEvent(event: GatewayEvent): void {
    this.events.dispatch(event)
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const handler of this.stateHandlers) handler(state)
  }
}
