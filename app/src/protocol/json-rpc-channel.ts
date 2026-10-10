/**
 * Transport-agnostic half of a Hermes JSON-RPC gateway connection.
 *
 * Ported from the upstream shared client so the app speaks the current
 * (v7) wire protocol. Upstream source of truth:
 *   ~/.hermes/hermes-agent/apps/shared/src/json-rpc-channel.ts
 *   ~/.hermes/hermes-agent/tui_gateway/server_requests.py
 *
 * Owns: request ids, the pending map with per-call timeouts + AbortSignal,
 * response -> typed error mapping, `event` notification decoding, server->client
 * requests (approval / clarify / sudo / secret / vault / ...), and the
 * `gateway.ping` heartbeat.
 *
 * The important bit for a phone: the backend ASKS the client questions over the
 * same socket. Miss `client.capabilities` and the agent stalls for the full
 * deadline (clarify blocks 300s) on a question that can never be answered.
 */

export type GatewayRequestId = number | string

export interface JsonRpcErrorPayload {
  code?: number
  data?: unknown
  message?: string
}

export interface ServerRequestParams extends Record<string, unknown> {
  session_id?: string
}

export interface JsonRpcFrame {
  error?: JsonRpcErrorPayload
  id?: GatewayRequestId | null
  method?: string
  params?: Record<string, unknown> | ServerRequestParams
  result?: unknown
}

/** One inbound server->client request, as handed to a `ServerRequestHandler`. */
export interface ServerRequest<M extends string = string, P extends ServerRequestParams = ServerRequestParams> {
  id: string
  method: M
  params: P
  sessionId?: string
  /**
   * Route the answer back to the backend that asked. Idempotent: the first
   * `respond` (or `fail`) wins; a request re-delivered after a reconnect
   * (`open_requests`) reuses the id, so a stale card answering twice is a
   * no-op on the wire.
   */
  respond: (result: Record<string, unknown>) => void
  /** Answer with a JSON-RPC error (the backend treats it as unanswered). */
  fail: (code: number, message: string) => void
  /** True when the request arrived via a replay rather than live. */
  replayed?: boolean
}

/** Handles one inbound server request; return `false` to decline (next handler tries). */
export type ServerRequestHandler = (request: ServerRequest) => boolean | void

/**
 * A frame is a server->client request when it carries BOTH a string id and a
 * method that isn't the event channel. Server ids are always `srq-<12 hex>`;
 * `event` is the notification channel, not a request.
 */
const isServerRequestFrame = (frame: JsonRpcFrame): frame is JsonRpcFrame & { id: string; method: string } =>
  typeof frame.id === 'string' && typeof frame.method === 'string' && frame.method !== 'event'

/** JSON-RPC error with optional structured `data` from the gateway. */
export class JsonRpcGatewayError extends Error {
  readonly code?: number
  readonly data?: unknown

  constructor(message: string, options?: { code?: number; data?: unknown }) {
    super(message)
    this.name = 'JsonRpcGatewayError'
    this.code = options?.code
    this.data = options?.data
  }
}

/** JSON-RPC "method not found". */
export const JSON_RPC_METHOD_NOT_FOUND = -32601
/** JSON-RPC "internal error" — used when a server-request handler throws. */
export const JSON_RPC_INTERNAL_ERROR = -32603

export function jsonRpcErrorFromFrame(raw: unknown, fallbackMessage = 'Mochi RPC failed'): JsonRpcGatewayError {
  const err = (raw && typeof raw === 'object' ? raw : {}) as JsonRpcErrorPayload

  return new JsonRpcGatewayError(
    typeof err.message === 'string' && err.message ? err.message : fallbackMessage,
    { code: typeof err.code === 'number' ? err.code : undefined, data: err.data },
  )
}

export interface JsonRpcTransport {
  send(text: string): void
}

export type HeartbeatLiveness = 'any-inbound' | 'response'

export interface JsonRpcRequestChannelOptions {
  createRequestId?: (nextId: number) => GatewayRequestId
  heartbeatDeadlineMs?: number
  heartbeatIntervalMs?: number
  /** Message used when a request is issued with no transport bound. */
  notConnectedErrorMessage?: string
  onEvent?: (event: GatewayEvent) => void
  onHeartbeatFailure?: (error: Error) => void
  onUnhandledRequest?: (request: { id: string; method: string; params: ServerRequestParams }) => void
  onRequestHandlerError?: (error: Error, request: { id: string; method: string; params: ServerRequestParams }) => void
  requestIdPrefix?: string
  requestTimeoutMs?: number
  /**
   * `'any-inbound'`: any inbound frame counts as liveness. Correct for a
   * phone — data flows constantly and a busy turn is not a stall.
   * `'response'`: only a pong or our own response counts.
   */
  heartbeatLiveness?: HeartbeatLiveness
}

export interface GatewayEvent<P = unknown> {
  payload?: P
  seq?: number
  session_id?: string
  type: string
}

type PendingCall = {
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
export const DEFAULT_HEARTBEAT_DEADLINE_MS = 45_000
const MAX_OUTSTANDING_PINGS = 8

// Hoisted decoder: attach mode can drive high-frequency binary frames and a
// fresh TextDecoder per message is avoidable GC pressure.
let wireDecoder: TextDecoder | null = null
function decodeBytes(bytes: ArrayBuffer): string {
  if (!wireDecoder) wireDecoder = new TextDecoder()
  return wireDecoder.decode(bytes)
}

/** Decode a socket `message.data` (string / ArrayBuffer / view) to text; `null` for anything else. */
export function wireFrameText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) return decodeBytes(raw)
  if (ArrayBuffer.isView(raw)) {
    return decodeBytes(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
  }
  return null
}

export class JsonRpcRequestChannel {
  private nextId = 0
  private readonly pending = new Map<GatewayRequestId, PendingCall>()
  private transport: JsonRpcTransport | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatSequence = 0
  private readonly outstandingPings = new Set<string>()
  private lastLivenessAt = 0
  private readonly requestHandlers: ServerRequestHandler[] = []
  // BUG-072: "once per connection generation" — actually enforced now. The
  // gateway.ready frame replays on reconnects, and each replay re-sent the
  // capabilities advertisement.
  private capabilitiesAdvertised = false
  // BUG-068: malformed frames were dropped with zero telemetry — a truncated
  // frame or an HTML error body looked exactly like a silent stall.
  private malformedFrames = 0
  private lastMalformedLogAt = 0
  private readonly options: Required<
    Omit<JsonRpcRequestChannelOptions, 'onEvent' | 'onHeartbeatFailure' | 'onRequestHandlerError' | 'onUnhandledRequest'>
  > &
    Pick<JsonRpcRequestChannelOptions, 'onEvent' | 'onHeartbeatFailure' | 'onRequestHandlerError' | 'onUnhandledRequest'>

  constructor(options: JsonRpcRequestChannelOptions = {}) {
    this.options = {
      createRequestId: options.createRequestId ?? ((nextId: number) => `${options.requestIdPrefix ?? 'r'}${nextId}`),
      heartbeatDeadlineMs: options.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatLiveness: options.heartbeatLiveness ?? 'any-inbound',
      notConnectedErrorMessage: options.notConnectedErrorMessage ?? 'gateway not connected',
      onEvent: options.onEvent,
      onHeartbeatFailure: options.onHeartbeatFailure,
      onRequestHandlerError: options.onRequestHandlerError,
      onUnhandledRequest: options.onUnhandledRequest,
      requestIdPrefix: options.requestIdPrefix ?? 'r',
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    }
  }

  get connected(): boolean {
    return this.transport !== null
  }

  /** Bind a new connection generation. Any previous generation's pending calls are the owner's to reject. */
  attach(transport: JsonRpcTransport): void {
    this.stopHeartbeat()
    this.transport = transport
    this.lastLivenessAt = Date.now()
    // BUG-072: a new generation re-advertises on its first gateway.ready.
    this.capabilitiesAdvertised = false
  }

  /** Drop the transport and fail every in-flight call with `error`. */
  detach(error: Error): void {
    this.stopHeartbeat()
    this.transport = null
    this.rejectAllPending(error)
  }

  owns(transport: JsonRpcTransport): boolean {
    return this.transport === transport
  }

  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.options.requestTimeoutMs,
    signal?: AbortSignal,
    notConnectedError: () => Error = () => new Error('gateway not connected'),
  ): Promise<T> {
    const transport = this.transport
    if (!transport) return Promise.reject(notConnectedError())
    if (signal?.aborted) return Promise.reject(new Error('Aborted'))

    const id = this.options.createRequestId(++this.nextId)

    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined

      const detachAbort = () => {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      }

      const pending: PendingCall = {
        resolve: value => {
          detachAbort()
          resolve(value as T)
        },
        reject: error => {
          detachAbort()
          reject(error)
        },
      }

      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            detachAbort()
            const seconds = Math.round(timeoutMs / 1000)
            reject(new Error(`request timed out after ${seconds}s: ${method}`))
          }
        }, timeoutMs)
      }

      if (signal) {
        onAbort = () => {
          this.clearPending(id)
          detachAbort()
          reject(new Error('Aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      this.pending.set(id, pending)

      try {
        transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        this.clearPending(id)
        detachAbort()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Answer an inbound server request with a response frame carrying the same
   * `srq-…` id. This is the ONLY way to reply to approval / clarify / sudo /
   * secret in the current protocol — there is no `*.respond` RPC method.
   * No-ops when the owning transport is gone (the backend then withdraws the
   * request itself on timeout).
   */
  respondServerRequest(id: string, result: Record<string, unknown>): void {
    try {
      this.transport?.send(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch {
      /* generation gone */
    }
  }

  /**
   * Register a handler for server->client requests (clarify, approval, sudo,
   * ...). Handlers are tried in registration order until one accepts; an
   * unhandled request is answered `-32601` so the backend never waits out its
   * deadline against a client that cannot answer.
   */
  onRequest(handler: ServerRequestHandler): () => void {
    this.requestHandlers.push(handler)

    return () => {
      const index = this.requestHandlers.indexOf(handler)
      if (index >= 0) this.requestHandlers.splice(index, 1)
    }
  }

  /**
   * Deliver a server request to the handlers. Live frames arrive through
   * `handleFrame`; `session.resume` / `session.events.since` answers carry
   * `open_requests` so an unanswered question survives a dropped socket.
   */
  deliverRequest(id: string, method: string, params: ServerRequestParams, replayed = false): boolean {
    let settled = false

    const send = (frame: Record<string, unknown>) => {
      if (settled) return
      settled = true
      try {
        this.transport?.send(JSON.stringify({ jsonrpc: '2.0', id, ...frame }))
      } catch {
        // The generation is gone; the backend withdraws the request itself.
      }
    }

    const sessionId = typeof params.session_id === 'string' ? params.session_id : undefined

    const request: ServerRequest = {
      id,
      method,
      params,
      sessionId,
      replayed,
      respond: result => send({ result }),
      fail: (code, message) => send({ error: { code, message } }),
    }

    for (const handler of this.requestHandlers) {
      let accepted: boolean | void
      try {
        accepted = handler(request)
      } catch (error) {
        // A crashing handler must not leave the backend waiting out its full
        // deadline (clarify blocks 300s): answer -32603 and stop.
        request.fail(JSON_RPC_INTERNAL_ERROR, `server request handler crashed: ${method}`)
        this.options.onRequestHandlerError?.(error instanceof Error ? error : new Error(String(error)), { id, method, params })
        return false
      }
      if (accepted !== false) return true
    }

    request.fail(JSON_RPC_METHOD_NOT_FOUND, `no handler for server request: ${method}`)
    this.options.onUnhandledRequest?.({ id, method, params })
    return false
  }

  /** Re-deliver the server requests a session still has open after a reconnect. */
  private deliverOpenRequests(result: unknown): void {
    const open = (result as { open_requests?: unknown } | null)?.open_requests
    if (!Array.isArray(open)) return

    for (const entry of open as Array<{ id?: unknown; method?: unknown; params?: unknown }>) {
      if (typeof entry?.id === 'string' && typeof entry.method === 'string') {
        const params = entry.params && typeof entry.params === 'object' ? (entry.params as ServerRequestParams) : {}
        this.deliverRequest(entry.id, entry.method, params, true)
      }
    }
  }

  /**
   * Route one inbound frame: a server request reaches the `onRequest`
   * handlers, a response settles its pending call (and re-delivers any
   * `open_requests` it carries), an `event` notification reaches `onEvent`.
   */
  handleFrame(text: string): JsonRpcFrame | null {
    let frame: JsonRpcFrame
    try {
      frame = JSON.parse(text) as JsonRpcFrame
    } catch {
      // BUG-068: rate-limited telemetry — a truncated frame or an HTML error
      // body used to vanish, looking exactly like a silent stall.
      this.malformedFrames += 1
      const now = Date.now()
      if (now - this.lastMalformedLogAt > 30_000) {
        this.lastMalformedLogAt = now
        // Count over the window only; keep the line short (no body content —
        // it can be a whole HTML page).
        console.warn(`[json-rpc] dropping malformed frame(s): ${this.malformedFrames} so far (${text.length} bytes)`)
      }
      return null
    }

    if (!frame || typeof frame !== 'object') return null

    if (this.options.heartbeatLiveness === 'any-inbound') {
      this.lastLivenessAt = Date.now()
    }

    if (isServerRequestFrame(frame)) {
      const params = frame.params && typeof frame.params === 'object' ? (frame.params as ServerRequestParams) : {}
      this.deliverRequest(frame.id, frame.method, params)
      return frame
    }

    if (frame.id !== undefined && frame.id !== null) {
      if (typeof frame.id === 'string' && this.outstandingPings.delete(frame.id)) {
        this.lastLivenessAt = Date.now()
        return frame
      }

      const call = this.pending.get(frame.id)
      if (call) {
        this.lastLivenessAt = Date.now()
        this.clearPending(frame.id)
        if (frame.error) {
          call.reject(jsonRpcErrorFromFrame(frame.error))
        } else {
          // `session.resume` / `session.activate` / `session.events.since`
          // answer with `open_requests` — the questions still waiting on this
          // session. They cannot ride the event replay ring, so they are
          // re-delivered here, before the caller sees the result.
          this.deliverOpenRequests(frame.result)
          call.resolve(frame.result)
        }
      }
      return frame
    }

    const params = frame.params as GatewayEvent | undefined
    if (frame.method === 'event' && params && typeof params.type === 'string') {
      if (params.type === 'gateway.ready') {
        // BUG-072: ready replays on every reconnect — advertise ONCE per
        // generation (reset by dropSocket), not on every replayed frame.
        if (!this.capabilitiesAdvertised) {
          this.capabilitiesAdvertised = true
          this.advertiseCapabilities()
        }
      }
      this.options.onEvent?.(params)
    }
    return frame
  }

  /**
   * Tell the backend, once per connection generation, that this client
   * answers server->client requests. Without it a backend treats the client as
   * a pre-v7 build and fails every clarify/approval immediately instead of
   * letting the card render.
   */
  private advertiseCapabilities(): void {
    this.request('client.capabilities', { server_requests: true }).catch(() => undefined)
  }

  startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastLivenessAt = Date.now()

    const transport = this.transport
    if (!transport || this.options.heartbeatIntervalMs <= 0 || this.options.heartbeatDeadlineMs <= 0) return

    this.heartbeatTimer = setInterval(() => {
      if (this.transport !== transport) return

      if (Date.now() - this.lastLivenessAt >= this.options.heartbeatDeadlineMs) {
        this.failHeartbeat(new Error('WebSocket heartbeat acknowledgement timed out'))
        return
      }

      const id = `heartbeat-${++this.heartbeatSequence}`
      this.outstandingPings.add(id)
      if (this.outstandingPings.size > MAX_OUTSTANDING_PINGS) {
        this.outstandingPings.delete(this.outstandingPings.values().next().value as string)
      }

      try {
        transport.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'gateway.ping', params: {} }))
      } catch (error) {
        this.failHeartbeat(error instanceof Error ? error : new Error(String(error)))
      }
    }, this.options.heartbeatIntervalMs)
  }

  stopHeartbeat(): void {
    this.outstandingPings.clear()
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private failHeartbeat(error: Error): void {
    this.stopHeartbeat()
    this.options.onHeartbeatFailure?.(error)
  }

  private clearPending(id: GatewayRequestId): void {
    const call = this.pending.get(id)
    if (call?.timer) clearTimeout(call.timer)
    this.pending.delete(id)
  }

  private rejectAllPending(error: Error): void {
    for (const [id, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer)
      this.pending.delete(id)
      call.reject(error)
    }
  }
}
