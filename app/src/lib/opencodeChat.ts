/**
 * OpenCode turn runner (OPENCODE-MODE contract — see .build/OPENCODE-MODE.md).
 *
 * One function, `runOpencodeTurn`, drives a whole chat turn: ensure server,
 * map the chat's persistent handle to an OpenCode session, submit the prompt,
 * pump the SSE stream, and call hooks that the UI feeds from chat.ts's own
 * reducers. It owns NO UI state — the hooks write chat.ts's atoms, so the
 * transcript renders with the exact same components as hermes turns.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  ocCreateSession,
  ocEnsureServer,
  ocHistory,
  ocPrompt,
  ocStream,
  type OcEvent,
  type OcHistoryMessage,
} from './opencodeClient'
import { log } from './log'

const MAP_KEY = 'hermes.opencode.map.v1'

// ── chat handle ↔ opencode session map ──────────────────────────────────────

async function readMap(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(MAP_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function writeMap(map: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(MAP_KEY, JSON.stringify(map))
  } catch {}
}

export async function ocSessionFor(mapKey: string): Promise<string | null> {
  if (!mapKey) return null
  const map = await readMap()
  return map[mapKey] ?? null
}

export async function ocRememberSession(mapKey: string, ocId: string): Promise<void> {
  if (!mapKey || !ocId) return
  const map = await readMap()
  map[mapKey] = ocId
  await writeMap(map)
}

export async function ocForgetSession(mapKey: string): Promise<void> {
  if (!mapKey) return
  const map = await readMap()
  delete map[mapKey]
  await writeMap(map)
}

async function ensureOcSession(mapKey: string, title: string): Promise<string> {
  const existing = await ocSessionFor(mapKey)
  if (existing) return existing
  const created = await ocCreateSession(title.slice(0, 80) || 'Moch chat')
  if (!created?.id) throw new Error('OpenCode did not return a session id')
  await ocRememberSession(mapKey, created.id)
  return created.id
}

// ── hooks ────────────────────────────────────────────────────────────────────

export interface OcPermissionInfo {
  id: string
  action: string
  resources: string[]
  message?: string
}

export interface OcTurnHooks {
  /** A new assistant row should begin (streaming). */
  start(): void
  text(delta: string): void
  thinking(delta: string): void
  tool(id: string, name: string, phase: 'running' | 'done' | 'failed', preview?: string, durationS?: number): void
  permission(req: OcPermissionInfo): void
  /** The turn reached a terminal state. `text` is the final assistant text (may be empty). */
  complete(text: string, failed: boolean, error?: string): void
}

export interface OcTurnOptions {
  /** The chat's PERSISTENT handle (hermes storedId) — never the volatile live sid. */
  mapKey: string
  /** Title used when creating the OpenCode session (first turn). */
  title?: string
  text: string
  hooks: OcTurnHooks
  /** Polled between events; true aborts the pump (user pressed stop). */
  isCancelled?: () => boolean
  /** Optional external AbortSignal — aborting it aborts the SSE connection. */
  signal?: AbortSignal
}

const TOOL_PREVIEW_MAX = 200

function previewOf(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined
  const s = typeof input === 'string' ? input : JSON.stringify(input)
  return s ? s.slice(0, TOOL_PREVIEW_MAX) : undefined
}

/**
 * Drive one turn end-to-end. Throws only on setup failures (server down,
 * session creation failed) — stream/turn errors arrive via `complete(_, true)`.
 */
export async function runOpencodeTurn(opts: OcTurnOptions): Promise<void> {
  const { mapKey, text, hooks, isCancelled, signal } = opts
  const ensured = await ocEnsureServer()
  if (!ensured.ok) throw new Error(ensured.error || 'The OpenCode server is not running')

  const ocId = await ensureOcSession(mapKey, opts.title || text.slice(0, 60))
  if (isCancelled?.()) return

  // One SSE connection per turn. Events for other sessions are filtered.
  let started = false
  let hasActivity = false
  let turnDone = false
  let failed = false
  let errorMsg: string | undefined
  let finalText = ''
  const toolNames = new Map<string, string>()
  const toolStartTs = new Map<string, number>()
  let cancelPoll: ReturnType<typeof setInterval> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let cap: ReturnType<typeof setTimeout> | null = null
  let resolveSilent: (v: 'silent') => void = () => {}
  // Our own controller always; an external signal (if any) forwards into it,
  // so finishOnce can unconditionally abort the SSE connection.
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else {
      try { signal.addEventListener('abort', () => controller.abort(), { once: true }) } catch {}
    }
  }

  const finishOnce = (() => {
    let called = false
    return () => {
      if (called) return
      called = true
      if (cancelPoll) clearInterval(cancelPoll)
      if (silenceTimer) clearTimeout(silenceTimer)
      if (cap) clearTimeout(cap)
      controller.abort()
    }
  })()

  const armSilence = () => {
    // 15 s with no frame at all means the relay is wedged — end the turn
    // (heartbeats arrive as comment lines, which never reach onEvent, so a
    // truly silent stream trips this; an active model keeps resetting it).
    if (silenceTimer) clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => resolveSilent('silent'), 15_000)
  }

  const onEvent = (e: OcEvent) => {
    const d = e.data || {}
    if (String(d.sessionID ?? '') !== ocId) return
    armSilence()
    switch (e.type) {
      case 'session.text.delta': {
        const delta = String(d.delta ?? '')
        if (delta) {
          finalText += delta
          if (!started) {
            hooks.start()
            started = true
          }
          hasActivity = true
          hooks.text(delta)
        }
        break
      }
      case 'session.reasoning.delta': {
        const delta = String(d.delta ?? '')
        if (delta) {
          if (!started) {
            hooks.start()
            started = true
          }
          hasActivity = true
          hooks.thinking(delta)
        }
        break
      }
      case 'session.tool.input.started': {
        const id = String(d.id ?? '')
        if (id) toolNames.set(id, String(d.name ?? 'tool'))
        break
      }
      case 'session.tool.called': {
        const id = String(d.id ?? '')
        if (!id) break
        if (!started) {
          hooks.start()
          started = true
        }
        hasActivity = true
        toolStartTs.set(id, Date.now())
        hooks.tool(id, toolNames.get(id) ?? 'tool', 'running', previewOf(d.input))
        break
      }
      case 'session.tool.progress': {
        const id = String(d.id ?? '')
        const out = d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, unknown>) : {}
        const preview = typeof out.preview === 'string' ? out.preview : undefined
        if (id && preview) hooks.tool(id, toolNames.get(id) ?? 'tool', 'running', preview.slice(0, TOOL_PREVIEW_MAX))
        break
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = String(d.id ?? '')
        if (!id) break
        const dur = toolStartTs.get(id)
        hooks.tool(
          id,
          toolNames.get(id) ?? 'tool',
          e.type === 'session.tool.failed' ? 'failed' : 'done',
          undefined,
          dur ? (Date.now() - dur) / 1000 : undefined,
        )
        break
      }
      case 'permission.asked': {
        hooks.permission({
          id: String(d.id ?? ''),
          action: String(d.action ?? ''),
          resources: Array.isArray(d.resources) ? d.resources.map(String) : [],
          message: typeof d.message === 'string' ? d.message : undefined,
        })
        break
      }
      case 'session.execution.succeeded':
        turnDone = true
        break
      case 'session.execution.failed':
        turnDone = true
        failed = true
        errorMsg = typeof d.error === 'string' ? d.error : 'The turn failed'
        break
      case 'session.error':
        // Field-level model error: keep streaming (a retry may follow), but
        // remember it so an idle-without-success still fails honestly.
        errorMsg = typeof d.error === 'string' ? d.error : errorMsg
        break
      case 'session.idle':
        // Idle with no terminal frame: only ends a turn that actually DID
        // something (text/tool arrived). An idle between prompt-accept and
        // first output — another client, an instant interrupt — is not an
        // end; the real answer may still stream afterward.
        if (hasActivity && !turnDone) {
          turnDone = true
          if (errorMsg) failed = true
        }
        break
      default:
        break
    }
    if (turnDone) finishOnce()
  }

  // Watchdogs: a prompt whose stream dies mid-turn must not spin busy forever.
  const streamDropped = new Promise<'dropped'>((resolve) => {
    ocStream(onEvent, controller.signal)
      .then(() => resolve('dropped'))
      .catch(() => resolve('dropped'))
  })
  // isCancelled poll (stop button) + silence (armSilence, per event) + an
  // absolute 15-minute cap: with no terminal frame by then the turn is dead.
  const silent = new Promise<'silent'>((resolve) => {
    resolveSilent = resolve
    cancelPoll = setInterval(() => {
      if (isCancelled?.()) resolve('silent')
    }, 500)
  })
  cap = setTimeout(() => resolveSilent('silent'), 15 * 60 * 1000)

  try {
    await ocPrompt(ocId, text)
  } catch (e) {
    finishOnce()
    throw e instanceof Error ? e : new Error(String(e))
  }
  // The assistant row begins only when the prompt is ACCEPTED — a failed
  // submit must never leave a phantom "typing" bubble behind.
  hooks.start()
  started = true
  armSilence()

  const winner = await Promise.race([streamDropped, silent])
  finishOnce()
  if (winner === 'silent' && !turnDone && isCancelled?.()) {
    finishOnce()
    hooks.complete(finalText, false)
    return
  }
  if (!turnDone) {
    // No terminal frame: the SSE connection died mid-turn (or went silent
    // for 15 s — a wedged relay). The turn is dead either way.
    failed = true
    errorMsg = errorMsg ?? (winner === 'silent'
      ? 'The model stopped responding'
      : 'The OpenCode connection dropped mid-turn')
  }
  hooks.complete(finalText, failed, failed ? errorMsg : undefined)
}

// ── history hydration ────────────────────────────────────────────────────────

export interface OcHistoryRow {
  role: 'user' | 'assistant'
  text: string
  ts: number
  /** Tool rows the UI may render (name + one-line status). */
  tools?: Array<{ id: string; name: string; ok: boolean }>
  thinking?: string
}

/** Map GET /api/session/:id/message (NEWEST FIRST) into chat rows, oldest first. */
export function mapOcHistory(messages: OcHistoryMessage[]): OcHistoryRow[] {
  const rows: OcHistoryRow[] = []
  for (const m of [...(messages ?? [])].reverse()) {
    if (m.type === 'user') {
      const text = String(m.payload?.text ?? '').trim()
      if (text) rows.push({ role: 'user', text, ts: m.time?.created ?? Date.now() })
      continue
    }
    if (m.type !== 'assistant') continue
    let text = ''
    let thinking = ''
    const tools: Array<{ id: string; name: string; ok: boolean }> = []
    for (const part of m.content ?? []) {
      if (part.type === 'text' && part.text) text += (text ? '\n' : '') + part.text
      else if (part.type === 'reasoning' && part.text) thinking += part.text
      else if (part.type === 'tool' && part.name) {
        const st = String(part.state?.status ?? 'done')
        tools.push({ id: String(part.id ?? part.name), name: part.name, ok: st !== 'error' })
      }
    }
    if (text || thinking || tools.length) {
      rows.push({ role: 'assistant', text: text.trim(), ts: m.time?.created ?? Date.now(), tools, thinking: thinking.trim() || undefined })
    }
  }
  return rows
}

export async function loadOcHistory(mapKey: string): Promise<OcHistoryRow[] | null> {
  const ocId = await ocSessionFor(mapKey)
  if (!ocId) return null
  try {
    const raw = await ocHistory(ocId)
    return mapOcHistory(raw ?? [])
  } catch (e) {
    log('warn', 'opencode', `history load failed: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}
