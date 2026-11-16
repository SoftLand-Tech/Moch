/**
 * OpenCode transport (OPENCODE-MODE contract — see .build/OPENCODE-MODE.md).
 *
 * The OpenCode server runs INSIDE the Moch Linux guest, bound to the phone's
 * own loopback (proot shares the network namespace — there is no second
 * stack). The RN runtime therefore reaches it directly at
 * http://127.0.0.1:4096 with HTTP Basic auth; JSON goes over the platform
 * fetch and the SSE stream over expo/fetch, whose response body is a real
 * ReadableStream. `usesCleartextTraffic="true"` is already set in the
 * release manifest, so loopback cleartext is legal.
 *
 * Every shape here was verified against a live opencode 2.3.0 server — do
 * not "fix" a field from memory; check .build/OPENCODE-MODE.md first.
 */
import { fetch as expoFetch } from 'expo/fetch'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { opencodePassword } from './opencodeSecret'
import { rpc } from './gateway'
import { log } from './log'

export const OC_BASE = 'http://127.0.0.1:4096'

export class OcError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'OcError'
  }
}

let cachedAuth: string | null = null

async function authHeader(): Promise<string> {
  if (cachedAuth) return cachedAuth
  const pw = await opencodePassword()
  cachedAuth = `Basic ${globalThis.btoa(`opencode:${pw}`)}`
  return cachedAuth
}

/** Test seam — forget the memoized Basic header (password changed). */
export function _resetOcAuth(): void {
  cachedAuth = null
}

async function base(): Promise<string> {
  // The port is fixed today; read overrides if a future build moves it.
  try {
    const v = await AsyncStorage.getItem('hermes.opencode.port.v1')
    if (v && /^\d+$/.test(v)) return `http://127.0.0.1:${v}`
  } catch {}
  return OC_BASE
}

export async function ocFetch<T = unknown>(
  path: string,
  opts?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const auth = await authHeader()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 20_000)
  let res: Response
  try {
    res = await fetch(`${await base()}${path}`, {
      method: opts?.method ?? 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw new OcError(0, `OpenCode server unreachable (${e instanceof Error ? e.message : String(e)})`)
  }
  // The timer stays armed across the BODY read: a hung response body (large
  // history, wedged relay) must abort too, not wait forever on res.text().
  const text = await res.text().catch((e) => {
    clearTimeout(timer)
    throw new OcError(0, `OpenCode response interrupted (${e instanceof Error ? e.message : String(e)})`)
  })
  clearTimeout(timer)
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg =
      data && typeof data === 'object' && 'message' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).message)
        : `HTTP ${res.status}`
    throw new OcError(res.status, msg)
  }
  // Envelopes: {data: …} on most routes; raw arrays/objects elsewhere.
  if (data && typeof data === 'object' && 'data' in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>).data as T
  }
  return data as T
}

// ── shapes (subsets; verified against 2.3.0 openapi + live events) ──────────

export interface OcSession {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
}

export interface OcModel {
  providerID: string
  modelID: string
  name?: string
}

export interface OcIntegration {
  id: string
  integrationID?: string
  name?: string
  activation?: string
}

export interface OcHistoryMessage {
  type: 'user' | 'assistant' | 'idle' | string
  time?: { created?: number }
  payload?: { text?: string }
  content?: Array<{
    type: 'text' | 'reasoning' | 'tool' | string
    text?: string
    id?: string
    name?: string
    state?: { status?: string; input?: unknown; output?: string }
    time?: { created?: number; ran?: number; completed?: number }
  }>
}

export interface OcEvent {
  type: string
  data: Record<string, unknown>
}

// ── calls ────────────────────────────────────────────────────────────────────

export const ocListSessions = () => ocFetch<OcSession[]>('/api/session', { timeoutMs: 15_000 })

export const ocCreateSession = (title: string) =>
  ocFetch<OcSession>('/api/session', { method: 'POST', body: { title } })

export const ocHistory = (id: string) =>
  ocFetch<OcHistoryMessage[]>(`/api/session/${encodeURIComponent(id)}/message`, { timeoutMs: 30_000 })

export const ocPrompt = (id: string, text: string) =>
  ocFetch<unknown>(`/api/session/${encodeURIComponent(id)}/prompt`, { method: 'POST', body: { text }, timeoutMs: 60_000 })

export const ocInterrupt = (id: string) =>
  ocFetch<unknown>(`/api/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST', timeoutMs: 15_000 })

export type OcPermissionReply = 'once' | 'always' | 'reject'

export const ocPermissionReply = (id: string, requestID: string, reply: OcPermissionReply) =>
  ocFetch<unknown>(
    `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestID)}/reply`,
    { method: 'POST', body: { reply }, timeoutMs: 15_000 },
  )

export const ocModels = () => ocFetch<OcModel[]>('/api/model', { timeoutMs: 30_000 })

export const ocDefaultModel = () => ocFetch<OcModel | null>('/api/model/default', { timeoutMs: 15_000 })

export const ocSetModel = (id: string, providerID: string, modelID: string) =>
  ocFetch<unknown>(`/api/session/${encodeURIComponent(id)}/model`, {
    method: 'POST',
    body: { model: { providerID, modelID } },
  })

export const ocIntegrations = () => ocFetch<OcIntegration[]>('/api/integration', { timeoutMs: 20_000 })

export const ocConnectKey = (integrationID: string, key: string) =>
  ocFetch<unknown>(
    `/api/integration/${encodeURIComponent(integrationID)}/connect/key`,
    { method: 'POST', body: { key }, timeoutMs: 30_000 },
  )

/**
 * The SSE pump. Resolves when the stream drops (server restart, network);
 * rejects only when the initial connection fails. Heartbeats (`: heartbeat`)
 * and non-JSON lines are ignored.
 */
export async function ocStream(
  handler: (e: OcEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const auth = await authHeader()
  let res: Response
  try {
    res = await expoFetch(`${await base()}/api/event`, {
      headers: { Authorization: auth, Accept: 'text/event-stream' },
      signal,
    })
  } catch (e) {
    throw new OcError(0, `event stream unreachable (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!res.ok || !res.body) throw new OcError(res.status, 'event stream unavailable')
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (!payload) continue
        try {
          const e = JSON.parse(payload) as { type?: string; data?: Record<string, unknown> }
          if (e.type) handler({ type: e.type, data: e.data ?? {} })
        } catch {
          // partial JSON across chunks is impossible (newline framing), a
          // bad frame is skipped like any SSE consumer would
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

/**
 * Start (or re-attach to) the guest server through the embedded gateway.
 * Idempotent on the python side. Used by chat + onboarding.
 */
export async function ocEnsureServer(): Promise<{ ok: boolean; error?: string }> {
  try {
    const password = await opencodePassword()
    const r = await rpc<{ ok?: boolean; error?: string }>('moch.opencode.ensure', { password }, 90_000)
    return { ok: r?.ok !== false, error: r?.error }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Liveness probe — one cheap authenticated call. */
export async function ocAlive(): Promise<boolean> {
  try {
    await ocFetch('/api/info', { timeoutMs: 6_000 })
    return true
  } catch {
    return false
  }
}

export function logOc(msg: string): void {
  log('info', 'opencode', msg)
}
