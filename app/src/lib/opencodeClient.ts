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
import { opencodePassword, opencodeBasicAuth, b64ascii, OC_PORT } from './opencodeSecret'
import { linuxTermProbe, linuxTermStart, linuxTermWrite } from './mochiRuntime'
import { guestRun } from './thinker'
import { rpc } from './gateway'
import { log } from './log'
import { ocHistoryPageQuery, nextOcHistoryCursor } from './ocHistory'
import type { OcFormAnswer, OcFormInfo } from './ocForm'

export type { OcFormAnswer, OcFormField, OcFormInfo, OcFormOption, OcFormValue } from './ocForm'

export const OC_BASE = 'http://127.0.0.1:4096'

export class OcError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'OcError'
  }
}

/**
 * THE user-facing OcError classifier (contract: .build/OPENCODE-MODE.md).
 * Every catch that shows a failure to the user renders THIS — status code
 * plus a short human class (403/quota, 404, 5xx, network), never a raw
 * body dump. Non-OcError throws pass their message through untouched.
 */
export function describeOcError(e: unknown): string {
  if (e instanceof OcError) {
    if (e.status === 0) return `OpenCode server not responding (network) — ${e.message}`
    if (e.status === 401) return 'HTTP 401 — auth rejected'
    if (e.status === 403) return 'HTTP 403 — auth/quota (key rejected or quota exhausted)'
    if (e.status === 404) return 'HTTP 404 — not found (model/session)'
    if (e.status >= 500) {
      const tail = e.message.trim().slice(-120)
      return `HTTP ${e.status} — OpenCode server error${tail ? `: ${tail}` : ''}`
    }
    return `HTTP ${e.status}${e.message ? `: ${e.message}` : ''}`
  }
  return e instanceof Error ? e.message : String(e)
}

let cachedAuth: string | null = null

async function authHeader(): Promise<string> {
  if (cachedAuth) return cachedAuth
  const pw = await opencodePassword()
  cachedAuth = opencodeBasicAuth(pw)
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
  opts?: {
    method?: string
    body?: unknown
    timeoutMs?: number
    unwrap?: boolean
    headers?: Record<string, string>
  },
): Promise<T> {
  const auth = await authHeader()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 20_000)
  let res: Response
  try {
    res = await fetch(`${await base()}${path}`, {
      method: opts?.method ?? 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json', ...opts?.headers },
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
    // Prefer the server's own `message`; otherwise the body's TAIL — even
    // raw JSON/HTML scraps say more than a bare "HTTP 500" (describeOcError
    // shows this text to the user).
    const msg =
      data && typeof data === 'object' && 'message' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).message)
        : text.trim().slice(-120) || `HTTP ${res.status}`
    throw new OcError(res.status, msg)
  }
  // Envelopes: {data: …} on most routes; raw arrays/objects elsewhere.
  if (opts?.unwrap !== false && data && typeof data === 'object' && 'data' in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>).data as T
  }
  return data as T
}

// ── shapes (subsets; verified against 2.3.0 openapi + live events) ──────────

export interface OcSession {
  id: string
  title?: string
  /**
   * The folder the session was created in (BUG-149). oc 2.3.0 takes
   * `directory` as a QUERY param on POST /api/session (the python twin's
   * send_prompt proves the mechanism) and echoes it on session rows; the
   * Sidebar buckets rows into the projects rail with it. Optional: sessions
   * minted before BUG-149 (and rows from a server that omits it) stay flat.
   */
  directory?: string
  outcome?: 'succeeded' | 'failed' | 'interrupted' | string
  time?: { created?: number; updated?: number; idle?: number }
}

export interface OcModel {
  /**
   * Model.Ref id — the BARE model id GET /api/model carries beside `modelID`.
   * POST /session/:id/model takes exactly this field (see ocSetModel), so it
   * must survive the trip from the inventory to the apply call.
   */
  id: string
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
  id?: string
  type: 'user' | 'assistant' | 'idle' | string
  time?: { created?: number | string }
  text?: string
  payload?: { text?: string }
  files?: Array<{ name?: string; filename?: string; mime?: string }>
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

export const ocGetSession = (id: string) =>
  ocFetch<OcSession>(`/api/session/${encodeURIComponent(id)}`, { timeoutMs: 15_000 })

export const ocActiveSessions = () =>
  ocFetch<Record<string, { type?: string }>>('/api/session/active', { timeoutMs: 15_000 })

/** Location carriers accepted across OpenCode server generations:
 *  - legacy 2.3.x reads `?directory=...`;
 *  - newer servers read `x-opencode-directory` (and `location[directory]`).
 * The header is safe on older servers and avoids adding an unknown query key
 * to newer ones. The value is a GUEST path (`/workspace/test`), never the
 * Android host spelling.
 */
function locationOpts(directory?: string): {
  headers?: Record<string, string>
} {
  return directory
    ? { headers: { 'X-Opencode-Directory': encodeURIComponent(directory) } }
    : {}
}

/**
 * Create a session in the project directory. `directory` is the guest path.
 */
export const ocCreateSession = (title: string, directory?: string) =>
  ocFetch<OcSession>(
    directory ? `/api/session?directory=${encodeURIComponent(directory)}` : '/api/session',
    { method: 'POST', body: { title }, ...locationOpts(directory) },
  )

export const ocHistory = async (id: string, limit = 200): Promise<OcHistoryMessage[]> => {
  const pageSize = Math.max(1, Math.min(200, Math.floor(limit)))
  const messages: OcHistoryMessage[] = []
  const seenCursors = new Set<string>()
  const seenIds = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await ocFetch<{
      data?: OcHistoryMessage[]
      cursor?: { previous?: string; next?: string }
    }>(`/api/session/${encodeURIComponent(id)}/message?${ocHistoryPageQuery(cursor, pageSize)}`, {
      timeoutMs: 30_000,
      unwrap: false,
    })
    const rows = Array.isArray(page?.data) ? page.data : []
    for (const row of rows) {
      if (row.id && seenIds.has(row.id)) continue
      if (row.id) seenIds.add(row.id)
      messages.push(row)
    }
    cursor = nextOcHistoryCursor(page)
    if (cursor && seenCursors.has(cursor)) throw new Error('OpenCode history pagination repeated a cursor')
    if (cursor) seenCursors.add(cursor)
  } while (cursor)
  return messages
}

export const ocPrompt = (id: string, text: string, directory?: string) =>
  ocFetch<unknown>(
    `/api/session/${encodeURIComponent(id)}/prompt${directory ? `?directory=${encodeURIComponent(directory)}` : ''}`,
    { method: 'POST', body: { text }, timeoutMs: 60_000, ...locationOpts(directory) },
  )

export const ocInterrupt = (id: string) =>
  ocFetch<unknown>(`/api/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST', timeoutMs: 15_000 })

export type OcPermissionReply = 'once' | 'always' | 'reject'

export interface OcPermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
}

export const ocListPermissions = (id: string) =>
  ocFetch<OcPermissionRequest[]>(`/api/session/${encodeURIComponent(id)}/permission`, { timeoutMs: 15_000 })

export const ocPermissionReply = (id: string, requestID: string, reply: OcPermissionReply) =>
  ocFetch<unknown>(
    `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestID)}/reply`,
    { method: 'POST', body: { decision: reply }, timeoutMs: 15_000 },
  )

/** Pending forms/questions for a session (opencode 2.3.0 Form.Service). */
export const ocListForms = (sessionId: string) =>
  ocFetch<OcFormInfo[]>(`/api/session/${encodeURIComponent(sessionId)}/form`, { timeoutMs: 15_000 })

export const ocFormReply = (sessionId: string, formId: string, answer: OcFormAnswer) =>
  ocFetch<unknown>(
    `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
    { method: 'POST', body: { answer }, timeoutMs: 15_000 },
  )

export const ocFormCancel = (sessionId: string, formId: string, message?: string) =>
  ocFetch<unknown>(
    `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}${
      message ? `?message=${encodeURIComponent(message)}` : ''
    }`,
    { method: 'DELETE', timeoutMs: 15_000 },
  )

export const ocModels = () => ocFetch<OcModel[]>('/api/model', { timeoutMs: 30_000 })

/**
 * Model inventory without a server: `opencode models` prints
 * `providerID/modelID` per line. Used in one-shot mode (and only there).
 */
export async function ocModelsOneShot(): Promise<OcModel[]> {
  const r = await guestRun('opencode models 2>/dev/null', 60_000)
  if (!r.ok) throw new OcError(0, (r.stderr || 'Could not list OpenCode models.').trim().slice(-200))
  const out: OcModel[] = []
  for (const line of r.stdout.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith(' ') || !t.includes('/')) continue
    const slash = t.indexOf('/')
    const providerID = t.slice(0, slash)
    const modelID = t.slice(slash + 1).split(/\s/)[0]
    if (providerID && modelID)
      // Ref id of a `provider/model` line is the bare model id. One-shot
      // never POSTs it (picks ride `-m provider/model`), but the field is
      // required on OcModel so the row shapes stay interchangeable.
      out.push({ id: modelID, providerID, modelID, name: modelID })
  }
  return out
}

export const ocDefaultModel = () => ocFetch<OcModel | null>('/api/model/default', { timeoutMs: 15_000 })

export const ocSetModel = (sessionId: string, providerID: string, modelId: string) =>
  ocFetch<unknown>(`/api/session/${encodeURIComponent(sessionId)}/model`, {
    method: 'POST',
    // Verified against 2.3.0 (packages/protocol session.switchModel →
    // Model.Ref): the payload is { model: { id, providerID, variant? } } and
    // unknown keys are rejected — the old { providerID, modelID } body was
    // refused with `missing key at ["ai"]["model"]`. The required `id` is
    // Model.Info.id (the bare model id), NOT `modelID`.
    body: { model: { id: modelId, providerID } },
  })

export const ocIntegrations = () => ocFetch<OcIntegration[]>('/api/integration', { timeoutMs: 20_000 })

/**
 * The official slash-command registry (opencode 2.x, verified against
 * .research/opencode: `command.list` → Command.Info = { name, description? }).
 * ocFetch unwraps the `{ location, data: [...] }` envelope, so this is the
 * bare array — kept tolerant of a bare array too (lib/ocCommands re-checks).
 */
export interface OcCommand {
  name: string
  description?: string
}

export const ocCommands = () => ocFetch<OcCommand[]>('/api/command', { timeoutMs: 20_000 })

/**
 * Run a registered command in a session (opencode 2.x `session.command`):
 * POST /api/session/:sessionID/command { name, text } → 204 empty. The
 * streamed output arrives over the SAME /api/event SSE pump a prompt uses,
 * so callers keep the turn runner unchanged. `text` is the free-form
 * argument text after the command name ('' for a bare /command).
 */
export const ocRunCommand = (sessionId: string, name: string, text: string) =>
  ocFetch<unknown>(`/api/session/${encodeURIComponent(sessionId)}/command`, {
    method: 'POST',
    body: { name, text },
    timeoutMs: 20_000,
  })

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
  onHeartbeat?: () => void,
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
  if (!res.ok || !res.body) {
    // Best-effort body read: a 401/403/500 on the stream connect must carry
    // its reason (auth/quota/server error) into the thrown error, not just
    // "unavailable" — the turn runner surfaces this via describeOcError.
    let detail = ''
    try { detail = (await res.text()).trim().slice(0, 200) } catch {}
    throw new OcError(
      res.status,
      `event stream unavailable (HTTP ${res.status}${detail ? `: ${detail}` : ''})`,
    )
  }
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
        if (line.startsWith(':')) {
          onHeartbeat?.()
          continue
        }
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
 * Start (or re-attach to) the guest server. THE single launch path.
 *
 * The launch goes through the TERMINAL BRIDGE (probe → start → type the
 * command) — the one context proven on-device to keep the server alive:
 * every launch from the python RPC thread (and the old `guestRun` nohup
 * launch this function used to do — which onboarding kept calling, so the
 * 1.0.31–1.0.34 python fixes never ran for it) futex-aborts ~30s in. The
 * python RPC is then called with `launch: false` to health-wait only.
 * Falls back to the python-side launch when there is no pty bridge
 * (desktop tests / fakes).
 */
export async function ocEnsureServer(): Promise<{ ok: boolean; error?: string }> {
  const run = ensureInFlight ?? (ensureInFlight = ensureServerOnce().finally(() => {
    ensureInFlight = null
  }))
  return run
}

/**
 * One serialized ensure. The old path typed a fresh `opencode serve` line
 * into the user's terminal on EVERY call — even when the server was already
 * healthy — so the Terminal screen filled with repeated launch commands,
 * job numbers, and the server password. This path now:
 *   - probes liveness first and never touches the terminal for a live server;
 *   - single-flights concurrent callers (boot, drawer, model sheet, turn);
 *   - types the launch HIDDEN (`stty -echo`, stderr silenced, leading space
 *     for HISTCONTROL=ignorespace) and only after a 15 s cooldown.
 */
let ensureInFlight: Promise<{ ok: boolean; error?: string }> | null = null
let lastLaunchAt = 0
const LAUNCH_COOLDOWN_MS = 15_000

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** POSIX single-quote a secret for the guest shell. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Type the launch into the existing PTY without leaving it in the visible
 * terminal: echo off before the command, the shell's own stderr muted while
 * it prints the job line, restore echo after. The first write carries no
 * secret (it only sets the history rule and disables echo) and is the one
 * visible line; the launch itself never echoes. Returns true when the
 * launch line was accepted by the bridge.
 */
async function typeOpencodeLaunchHidden(password: string): Promise<boolean> {
  const write = (text: string) => linuxTermWrite(b64ascii(text))
  try {
    if (!(await write(' export HISTCONTROL=ignorespace; stty -echo\n'))) return false
    await sleepMs(200)
    const cmd =
      ` exec 2>/dev/null; cd /workspace && export OPENCODE_PASSWORD=${shQuote(password)} && ` +
      `opencode serve --hostname 127.0.0.1 --port ${OC_PORT} ` +
      `>/root/opencode.log 2>&1 & exec 2>&1\n`
    const wrote = await write(cmd)
    await sleepMs(200)
    return wrote
  } finally {
    // Never leave the user's shell with echo disabled.
    await write(' stty echo\n').catch(() => false)
  }
}

async function ensureServerOnce(): Promise<{ ok: boolean; error?: string }> {
  /** BUG-148: the python ensure path now also starts the host-side browser
   * MCP adapter and seeds the guest's opencode.json (mcp → moch-browser).
   * The port comes back here only for the LOG — the guest already has the
   * config; TS never handles the relay token. */
  const logBrowserMcp = (r?: { browser_mcp?: { ok?: boolean; port?: number; error?: string } } | null) => {
    const m = r?.browser_mcp
    if (m?.port) {
      log('info', 'opencode',
        m.ok === false
          ? `browser MCP adapter unavailable (${m.error ?? 'unknown reason'})`
          : `browser MCP adapter on 127.0.0.1:${m.port}`)
    }
  }
  try {
    const password = await opencodePassword()
    const alive = await ocAlive()
    let hasPty = false
    let launchTyped = false
    if (!alive) {
      const probe = await linuxTermProbe()
      hasPty = !!probe?.pty
      if (hasPty) {
        const started = await linuxTermStart(80, 24) // idempotent: alive stays alive
        if (started?.ok) {
          if (Date.now() - lastLaunchAt < LAUNCH_COOLDOWN_MS) {
            log('info', 'opencode', 'launch cooldown — waiting for the in-flight server start')
          } else {
            lastLaunchAt = Date.now()
            launchTyped = await typeOpencodeLaunchHidden(password)
          }
        }
      }
    }
    // A live server (or a just-typed launch) only needs the gateway-side
    // health wait + browser-MCP seed. With no pty bridge, the python-side
    // launch is the remaining path (it uses the same hidden typing there).
    const pythonLaunches = !alive && !hasPty
    const r = await rpc<{ ok?: boolean; error?: string; browser_mcp?: { ok?: boolean; port?: number; error?: string } }>(
      'moch.opencode.ensure', { password, launch: pythonLaunches }, 90_000)
    logBrowserMcp(r)
    if (!r?.ok && launchTyped) log('warn', 'opencode', 'typed launch did not come up in time — retry later')
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
