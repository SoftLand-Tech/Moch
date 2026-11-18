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
  ocRunCommand,
  ocStream,
  describeOcError,
  type OcEvent,
  type OcHistoryMessage,
} from './opencodeClient'
import { loadOcCommands } from './ocCommands'
import { guestRun } from './thinker'
import { log } from './log'
// BUG-149: session mints carry the active project's cwd, exactly like
// createSession does for hermes chats (chat.ts is mode-agnostic here —
// workspace's atoms are the same source the hermes create reads).
import { activeProjectIdAtom, projectsAtom } from './workspace'
import { pickProjectCwd } from './projectScope'

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

// ── per-chat model picks (one-shot mode has no server to remember them) ────
// Server mode applies picks live via ocSetModel; one-shot passes `-m` per
// turn, so the pick must survive restarts here. Same AsyncStorage, own key.

const PICK_KEY = 'hermes.opencode.picks.v1'

async function readPicks(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(PICK_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The model picked for a chat (storedId-keyed), or null. */
export async function ocPickFor(storedId: string): Promise<string | null> {
  if (!storedId) return null
  try {
    const map = await readPicks()
    return map[storedId] ?? null
  } catch {
    return null
  }
}

export async function rememberOcPick(storedId: string, modelID: string): Promise<void> {
  if (!storedId || !modelID) return
  try {
    const map = await readPicks()
    map[storedId] = modelID
    await AsyncStorage.setItem(PICK_KEY, JSON.stringify(map))
  } catch {}
}

/** The drawer's selected project's folder, or undefined (Personal bucket /
 *  folderless project — minting in an arbitrary cwd would file the session
 *  under the wrong project, the same rule pickProjectCwd encodes). */
function currentProjectCwd(): string | undefined {
  return pickProjectCwd(
    projectsAtom.get().map((p) => ({ id: p.id, path: p.primaryPath, isNoProject: p.isNoProject })),
    activeProjectIdAtom.get(),
  )
}

async function ensureOcSession(mapKey: string, title: string): Promise<string> {
  const existing = await ocSessionFor(mapKey)
  if (existing) return existing
  // BUG-149: the mint files the session under the selected project so the
  // drawer can group it (projectIdForCwd(row.directory)).
  const created = await ocCreateSession(title.slice(0, 80) || 'Moch chat', currentProjectCwd())
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
  /**
   * Official OpenCode command turn (issue 16): when set, POST
   * /api/session/:id/command {name, text} instead of a plain prompt, AFTER
   * the session is ensured. Output still streams over the same SSE pump, so
   * the transcript renders exactly like a normal OC turn.
   */
  command?: { name: string; text: string }
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
  // The server (re)started or was re-attached — refresh the official command
  // registry so the palette and the command dispatch see the live list.
  // Fire-and-forget: never delay or fail the turn over the palette cache.
  void loadOcCommands({ force: true }).catch(() => {})

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

  // Events in flight: a tool that has STARTED but not finished legitimately
  // produces no frames while it generates/runs (a big file write can stream
  // its input for minutes). The 15 s wedge detector must not fire through
  // that — it killed healthy turns mid-write. Tracked by id, removed on
  // success/failed.
  const activeTools = new Set<string>()
  let lastSilenceLimitMs = 15_000
  const armSilence = () => {
    // No frame at all means the relay is wedged — end the turn. Heartbeats
    // arrive as comment lines, which never reach onEvent, so a truly silent
    // stream trips this; an active model keeps resetting it. In-flight
    // tools get a much longer leash: silence during a running tool is normal.
    if (silenceTimer) clearTimeout(silenceTimer)
    lastSilenceLimitMs = activeTools.size > 0 ? 300_000 : 15_000
    silenceTimer = setTimeout(() => resolveSilent('silent'), lastSilenceLimitMs)
  }

  const onEvent = (e: OcEvent) => {
    const d = e.data || {}
    if (String(d.sessionID ?? '') !== ocId) return
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
        // The FIRST signal a tool exists. Show the row NOW — waiting for
        // .called hid long tools (big file writes) for their whole input
        // phase, so a turn could die with the tool never rendered at all.
        const id = String(d.id ?? '')
        if (!id) break
        const name = String(d.name ?? 'tool')
        toolNames.set(id, name)
        activeTools.add(id)
        toolStartTs.set(id, Date.now())
        if (!started) {
          hooks.start()
          started = true
        }
        hasActivity = true
        hooks.tool(id, name, 'running')
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
        if (!toolStartTs.has(id)) toolStartTs.set(id, Date.now())
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
        activeTools.delete(id)
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
        // `error` is usually a string, but the server also ships objects/
        // arrays — stringify those (tail) so the actual reason survives
        // instead of collapsing to the generic 'The turn failed'.
        errorMsg =
          typeof d.error === 'string'
            ? d.error
            : d.error !== null && d.error !== undefined
              ? JSON.stringify(d.error).slice(-160)
              : 'The turn failed'
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
    // Re-arm AFTER the switch: the silence limit depends on whether a tool
    // is in flight (events above may have added/removed one).
    armSilence()
    if (turnDone) finishOnce()
  }

  // Watchdogs: a prompt whose stream dies mid-turn must not spin busy forever.
  // The rejection reason is KEPT — a stream that drops without a terminal
  // frame reports WHY it died (403/quota, 5xx, network) via describeOcError.
  let streamErr: unknown = null
  const streamDropped = new Promise<'dropped'>((resolve) => {
    ocStream(onEvent, controller.signal)
      .then(() => resolve('dropped'))
      .catch((e: unknown) => {
        streamErr = e
        resolve('dropped')
      })
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
    if (opts.command) {
      // Official command (issue 16): same session, same SSE stream — only
      // the submit endpoint differs. An OcError here propagates exactly
      // like a failed prompt submit.
      await ocRunCommand(ocId, opts.command.name, opts.command.text)
    } else {
      await ocPrompt(ocId, text)
    }
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
    // No terminal frame: the SSE connection died mid-turn (or went silent —
    // a wedged relay). The turn is dead either way; the message says which,
    // with the drop reason when the stream rejected. The silence message
    // reports the limit that actually fired (15 s idle / 180 s with a tool
    // in flight) so a long silent tool reads differently from a dead stream.
    failed = true
    errorMsg = errorMsg ?? (winner === 'silent'
      ? `The model stopped responding (no events for ${Math.round(lastSilenceLimitMs / 1000)}s, ${hasActivity ? 'mid-answer' : 'before any output'})`
      : streamErr
        ? `The OpenCode connection dropped mid-turn — ${describeOcError(streamErr)}`
        : 'The OpenCode connection dropped mid-turn')
  }
  hooks.complete(finalText, failed, failed ? errorMsg : undefined)
}

// ── one-shot mode (no server): `opencode run` per turn ──────────────────────
// The guest server (Bun's long-lived HTTP loop) crashes under proot, but the
// one-shot CLI survives: same binary, same models, no server needed. One
// turn = one `run` invocation; session continuity comes from `-s`, models
// from `-m`, output from `--format json` (JSONL). No streaming, no
// interactive permissions — the answer arrives whole.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
/** `> build · big-pickle`-style header lines the CLI prints above the answer. */
const RUN_HEADER_RE = /^>\s.*$/
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/
const SAFE_MODEL_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#[A-Za-z0-9_.-]+)?$/

/** UTF-8 → base64 with surrogate-pair support (emoji must survive the pipe). */
function utf8ToB64(input: string): string {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    let cp = input.codePointAt(i) ?? 0
    if (cp > 0xffff) i++
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = i + 1 < bytes.length ? bytes[i + 1] : -1
    const c = i + 2 < bytes.length ? bytes[i + 2] : -1
    const n = (a << 16) | ((b < 0 ? 0 : b) << 8) | (c < 0 ? 0 : c)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b < 0 ? '=' : B64[(n >> 6) & 63]) + (c < 0 ? '=' : B64[n & 63])
  }
  return out
}

export interface OcRunPart {
  text: string
  thinking: string
  sessionId: string | null
  tools: Array<{ id: string; name: string; ok: boolean }>
}

/** Parse `opencode run --format json` (JSONL): text/reasoning/session/tools. */
export function parseRunJsonl(stdout: string): OcRunPart {
  let text = ''
  let thinking = ''
  let sessionId: string | null = null
  const tools: Array<{ id: string; name: string; ok: boolean }> = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t || !t.startsWith('{')) continue
    try {
      const e = JSON.parse(t) as {
        sessionID?: unknown
        part?: { type?: unknown; text?: unknown; name?: unknown; id?: unknown; state?: { status?: unknown } }
      }
      if (typeof e.sessionID === 'string' && !sessionId) sessionId = e.sessionID
      const p = e.part
      if (!p || typeof p !== 'object') continue
      if (p.type === 'text' && typeof p.text === 'string') text += p.text
      else if (p.type === 'reasoning' && typeof p.text === 'string') thinking += p.text
      else if (p.type === 'tool' && typeof p.name === 'string') {
        tools.push({ id: String(p.id ?? p.name), name: p.name, ok: String(p.state?.status ?? 'done') !== 'error' })
      }
    } catch {
      // Non-JSON line (banners go to stderr anyway) — skipped, never fatal.
    }
  }
  return { text: text.trim(), thinking: thinking.trim(), sessionId, tools }
}

/** Strip ANSI + CLI header lines from default-format output (fallback path). */
export function cleanRunText(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .split('\n')
    .filter((l) => !RUN_HEADER_RE.test(l.trim()))
    .join('\n')
    .trim()
}

export interface OcOneShotOptions {
  /** The chat's PERSISTENT handle (hermes storedId) — keys the session map. */
  mapKey: string
  text: string
  /** `provider/model` the user picked (omitted = server default). */
  model?: string
  isCancelled?: () => boolean
}

export interface OcOneShotResult extends OcRunPart {
  failed: boolean
  error?: string
}

/**
 * One turn without a server. Throws only on bridge/guest failures (the
 * caller marks the row failed); model-level problems arrive as
 * `{failed:true, error}` with whatever text did come back.
 */
export async function runOneShotTurn(opts: OcOneShotOptions): Promise<OcOneShotResult> {
  const existing = await ocSessionFor(opts.mapKey)
  const idPart =
    existing && SAFE_ID_RE.test(existing) ? ` -s '${existing}'` : ''
  const modelPart =
    opts.model && SAFE_MODEL_RE.test(opts.model) ? ` -m '${opts.model}'` : ''
  // Prompt via stdin (base64 pipe): arbitrary user text can never break the
  // shell line, and emoji survive through the correct UTF-8 encoder above.
  const cmd = `echo ${utf8ToB64(opts.text)} | base64 -d | opencode run --format json${idPart}${modelPart}`
  const r = await guestRun(cmd, 300_000)
  if (!r.ok) {
    if (opts.isCancelled?.()) {
      return { text: '', thinking: '', sessionId: existing, tools: [], failed: true, error: 'Stopped.' }
    }
    // Exit code + output tail: the CLI prints its real reason (auth, quota,
    // model not found) on stderr, stdout is the fallback channel. The
    // bridge maps ok→code 0/1 (thinker.ts) — coarse, but honest next to it.
    const tail = (r.stderr.trim() || r.stdout.trim()).slice(-300)
    throw new Error(`one-shot run failed (exit ${r.code}): ${tail || 'no output'}`)
  }
  const parsed = parseRunJsonl(r.stdout)
  const sessionId = parsed.sessionId ?? existing
  if (sessionId) await ocRememberSession(opts.mapKey, sessionId)
  if (!parsed.text && !parsed.thinking) {
    // No JSONL text (permission refusal, empty answer): show the raw tail
    // so the failure is visible instead of an empty bubble — plus stderr,
    // where the CLI explains WHY nothing came back.
    const raw = cleanRunText(r.stdout).slice(-800)
    const errTail = r.stderr.trim().slice(-300)
    return {
      text: '', thinking: '', sessionId, tools: parsed.tools,
      failed: true,
      error: errTail ? `${raw || 'The model returned nothing.'}\n${errTail}` : raw || 'The model returned nothing.',
    }
  }
  return { ...parsed, sessionId, failed: false }
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
