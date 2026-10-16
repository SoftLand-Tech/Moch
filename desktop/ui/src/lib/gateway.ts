/**
 * Local gateway connection — the desktop counterpart of the phone's
 * src/lib/gateway.ts, minus everything remote (pairing, relay, remembered
 * computers, TLS gates): Moch Desktop owns exactly one gateway, on loopback,
 * spawned by the Tauri shell. The webview gets its port + token from
 * `gateway_start`, connects the SAME transport-agnostic v7 client, and
 * auto-reconnects with jittered backoff until the runtime says otherwise.
 */

import { atom, computed } from 'nanostores'
import { invoke } from './tauri'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
  if (url === currentUrl && client && (client as unknown as { socket: unknown }).socket) {
    // connected or connecting on the same URL — the client's own idempotence guard
  }
  currentUrl = url
  const cli = ensureClient()
  connectionState.set('connecting')
  try {
    await cli.connect(url)
  } catch (err) {
    if (gen !== connectGen) return
    connectionState.set('error')
    scheduleReconnect()
    return
  }
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

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  if (!client) throw new Error('gateway not connected')
  if (timeoutMs !== undefined) return client.request<T>(method, params, timeoutMs)
  return client.request<T>(method, params)
}
