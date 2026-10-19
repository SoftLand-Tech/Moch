/**
 * Local gateway connection — the desktop counterpart of the phone's
 * src/lib/gateway.ts, minus everything remote (pairing, relay, remembered
 * computers, TLS gates): Moch Desktop owns exactly one gateway, on loopback,
 * spawned by the Tauri shell. The webview gets its port + token from
 * `gateway_start`, connects the SAME transport-agnostic v7 client, and
 * auto-reconnects with jittered backoff until the runtime says otherwise.
 */

import { atom, computed } from 'nanostores'
import { invoke, listen } from './tauri'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { JsonRpcGatewayClient, type ConnectionState, type GatewayEvent, type ServerRequest } from '../protocol/json-rpc-gateway'

export interface GatewayStatusPayload {
  running: boolean
  port: number | null
  token: string | null
  home: string | null
  workspace: string | null
}

export const connectionState = atom<ConnectionState>('idle')
export const runtimeBoot = atom<{ phase: 'booting' | 'ready' | 'error'; message: string }>({ phase: 'booting', message: 'Starting the local runtime…' })
export const gatewayInfo = atom<GatewayStatusPayload | null>(null)
export const gatewayLogs = atom<string[]>([])
export const isConnected = computed(connectionState, (s) => s === 'open')
export const workspaceDir = computed(gatewayInfo, (g) => g?.workspace ?? null)
export const hermesHome = computed(gatewayInfo, (g) => g?.home ?? null)

let client: JsonRpcGatewayClient | null = null
let connectGen = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let wantConnection = false
let currentUrl = ''

type EventSink = (e: GatewayEvent) => void
const sinks = new Set<EventSink>()
export function onEvent(sink: EventSink): () => void {
  sinks.add(sink)
  return () => { sinks.delete(sink) }
}

type RequestSink = (req: ServerRequest) => boolean | void
const requestSinks = new Set<RequestSink>()
export function onServerRequest(sink: RequestSink): () => void {
  requestSinks.add(sink)
  return () => { requestSinks.delete(sink) }
}

function dispatch(e: GatewayEvent) {
  for (const s of sinks) {
    try { s(e) } catch (err) { console.warn('[gateway] sink threw', err) }
  }
}

function dispatchRequest(req: ServerRequest): boolean {
  for (const s of requestSinks) {
    let accepted: boolean | void
    try { accepted = s(req) } catch (err) { console.warn('[gateway] request sink threw', err); return false }
    if (accepted !== false) return true
  }
  return false
}

function ensureClient(): JsonRpcGatewayClient {
  if (client) return client
  const cli = new JsonRpcGatewayClient({
    connectTimeoutMs: 8_000,
    requestTimeoutMs: 120_000,
    onUnhandledRequest: (req) => console.warn('[gateway] unhandled server request', req.method),
  })
  cli.onAny((e) => dispatch(e))
  cli.onRequest((req) => dispatchRequest(req))
  cli.onState((s) => {
    connectionState.set(s)
    if (s === 'closed' || s === 'error') scheduleReconnect()
  })
  client = cli
  return cli
}

let reconnectAttempt = 0
function scheduleReconnect() {
  if (!wantConnection || reconnectTimer) return
  const attempt = ++reconnectAttempt
  const base = Math.min(500 * 2 ** Math.min(attempt - 1, 5), 10_000)
  const delay = Math.round(base * (0.7 + Math.random() * 0.6))
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!wantConnection) return
    void dial().catch(() => {})
  }, delay)
}

async function dial(): Promise<void> {
  const gen = ++connectGen
  const info = gatewayInfo.get()
  if (!info?.port || !info.token) return
  const url = `ws://127.0.0.1:${info.port}/api/ws?token=${encodeURIComponent(info.token)}`
  currentUrl = url
  const cli = ensureClient()
  if (cli.connectionState !== 'open') connectionState.set('connecting')
  try {
    await cli.connect(url)
  } catch (err) {
    if (gen !== connectGen) {
      // A newer dial owns the atom — still resync so it never lies.
      connectionState.set(cli.connectionState)
      return
    }
    connectionState.set('error')
    scheduleReconnect()
    return
  }
  // The client's socket state is the truth — sync the atom on every exit so
  // concurrent dials (StrictMode double-boot) can never strand it at
  // 'connecting' over a live connection.
  connectionState.set(cli.connectionState)
  if (gen !== connectGen) return
  reconnectAttempt = 0
}

/** Boot (or adopt) the runtime via the Tauri shell, then connect. Idempotent. */
export async function startGateway(): Promise<void> {
  wantConnection = true
  try {
    const status = await invoke<GatewayStatusPayload>('gateway_start')
    gatewayInfo.set(status)
    if (status.running && status.port) {
      runtimeBoot.set({ phase: 'ready', message: 'Runtime ready' })
      await dial()
      return
    }
    runtimeBoot.set({ phase: 'error', message: 'Runtime did not come up' })
  } catch (err) {
    runtimeBoot.set({ phase: 'error', message: String(err) })
  }
}

export async function restartGateway(): Promise<void> {
  wantConnection = true
  try { client?.close() } catch { /* already closed */ }
  client = null
  currentUrl = ''
  runtimeBoot.set({ phase: 'booting', message: 'Restarting the runtime…' })
  await startGateway()
}

export async function refreshGatewayStatus(): Promise<void> {
  try {
    const status = await invoke<GatewayStatusPayload>('gateway_status')
    gatewayInfo.set(status)
    if (!status.running) runtimeBoot.set({ phase: 'error', message: 'Runtime is not running' })
  } catch { /* shell not ready */ }
}

/** Wire the Tauri event feed (log lines). Returns a disposer. */
export function wireEvents(): () => void {
  let stop: (() => void) | null = null
  let stopped = false
  void listen<string>('gateway://log', (e) => {
    gatewayLogs.set([...gatewayLogs.get().slice(-400), e.payload])
  }).then((un) => {
    if (stopped) un()
    else stop = un
  })
  return () => {
    stopped = true
    stop?.()
  }
}

export function getClient(): JsonRpcGatewayClient | null {
  return client
}

/** Live debug handle (console): `__moch.net()` shows the connection guts. */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __moch?: { net: () => unknown } }).__moch = {
    net: () => ({
      hasClient: !!client,
      clientState: client?.connectionState ?? 'no client',
      socketUrl: (client as unknown as { socketUrl?: string } | null)?.socketUrl ?? null,
      socketReady: (client as unknown as { socket?: WebSocket } | null)?.socket?.readyState ?? null,
      wantConnection,
      atomState: connectionState.get(),
      reconnectTimerActive: reconnectTimer !== null,
      reconnectAttempt,
      gatewayInfo: gatewayInfo.get(),
      boot: runtimeBoot.get(),
    }),
  }
}

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  if (!client) throw new Error('gateway not connected')
  if (timeoutMs !== undefined) return client.request<T>(method, params, timeoutMs)
  return client.request<T>(method, params)
}

/**
 * REST call into the gateway (uploads, TTS, STT) — always proxied: the
 * gateway's CORS allowlist doesn't cover the webview origin, so plain
 * fetch() is refused. Returns the raw body: text when `binary` is false,
 * decoded bytes (Uint8Array) when true.
 */
export async function gwFetch(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: Uint8Array | string; contentType?: string; binary?: boolean } = {},
): Promise<Uint8Array | string> {
  const method = opts.method ?? 'GET'
  let b64: string | undefined
  if (opts.body !== undefined) {
    const bytes = typeof opts.body === 'string' ? new TextEncoder().encode(opts.body) : opts.body
    b64 = bytesToBase64(bytes)
  }
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const raw = await invoke<string>('gw_fetch', {
      path,
      method,
      bodyB64: b64,
      contentType: opts.contentType,
    })
    return opts.binary ? base64ToBytes(raw) : bytesToUtf8(base64ToBytes(raw))
  }
  // Preview: the dev-bridge proxies with the token from the state file.
  const res = await fetch(`/dev-bridge/gw?method=${method}&path=${encodeURIComponent(path)}`, {
    method: opts.body !== undefined ? 'POST' : 'GET',
    ...(opts.body !== undefined
      ? {
          headers: {
            'x-dev-method': method,
            ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
          },
          body: opts.body as BodyInit | undefined,
        }
      : {}),
  })
  if (!res.ok) throw new Error(`gw proxy -> HTTP ${res.status}`)
  if (opts.binary) return new Uint8Array(await res.arrayBuffer())
  return res.text()
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
