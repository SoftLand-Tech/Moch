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
  ocActiveSessions,
  ocCreateSession,
  ocEnsureServer,
  ocGetSession,
  ocHistory,
  ocListForms,
  ocPrompt,
  ocRunCommand,
  ocStream,
  describeOcError,
  type OcEvent,
} from './opencodeClient'
import { extractOcEventSessionId, parseOcForm, type OcFormInfo } from './ocForm'
import { mapOcHistory, type OcHistoryRow } from './ocHistory'
import { loadOcCommands } from './ocCommands'
import {
  OC_ACTIVITY_CAP_MS,
  OC_IDLE_SILENCE_MS,
  computeOcSilenceLimitMs,
  decideOcDisconnectAction,
} from './ocTurnWatchdog'
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

/** Reverse lookup: find an existing local chat handle (`storedId`) mapped to `ocId`, if any. */
export async function findStoredIdForOcSession(ocId: string, liveKeys?: Iterable<string>): Promise<string | null> {
  if (!ocId) return null
  const map = await readMap()
  const candidates: string[] = []
  for (const [k, v] of Object.entries(map)) {
    if (v === ocId) candidates.push(k)
  }
  if (!candidates.length) return null
  if (liveKeys) {
    const liveSet = new Set(liveKeys)
    const liveMatch = candidates.find((k) => liveSet.has(k))
    if (liveMatch) return liveMatch
  }
  return candidates[candidates.length - 1]
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
  /** The `question` tool opened an interactive form prompt for the user. */
  question?: (form: OcFormInfo) => void
  /** A pending form prompt was answered or cancelled on the server. */
  questionResolved?: (formId: string) => void
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

  // Watch and reconnect SSE across long tool generation, retries, or brief drops.
  let started = false
  let hasActivity = false
  let turnDone = false
  let failed = false
  let errorMsg: string | undefined
  let finalText = ''
  let compacting = false
  let retryAtMs: number | null = null
  let rebindCount = 0
  const toolNames = new Map<string, string>()
  const toolStartTs = new Map<string, number>()
  let cancelPoll: ReturnType<typeof setInterval> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let cap: ReturnType<typeof setTimeout> | null = null
  let resolveSilent: (v: 'silent') => void = () => {}
  let attemptController: AbortController | null = null
  let disposed = false

  const abortExternal = () => {
    disposed = true
    attemptController?.abort()
    resolveSilent('silent')
  }
  if (signal) {
    if (signal.aborted) abortExternal()
    else {
      try { signal.addEventListener('abort', abortExternal, { once: true }) } catch {}
    }
  }

  const finishOnce = (() => {
    let called = false
    return () => {
      if (called) return
      called = true
      disposed = true
      if (cancelPoll) clearInterval(cancelPoll)
      if (silenceTimer) clearTimeout(silenceTimer)
      if (cap) clearTimeout(cap)
      if (signal) {
        try { signal.removeEventListener('abort', abortExternal) } catch {}
      }
      attemptController?.abort()
    }
  })()

  // Events in flight: track active tool calls, compaction, scheduled retries,
  // and interactive prompts (permission / form question) so silent gaps during
  // slow reasoning or large tool writes wait generously and probe OpenCode
  // before failing.
  const activeTools = new Set<string>()
  const awaitingUser = new Set<string>()
  let lastSilenceLimitMs = OC_IDLE_SILENCE_MS
  const armSilence = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
    if (disposed || turnDone) return
    const limit = computeOcSilenceLimitMs({
      awaitingUserCount: awaitingUser.size,
      activeToolCount: activeTools.size,
      compacting,
      retryAtMs,
    })
    if (limit === null) return
    lastSilenceLimitMs = limit
    silenceTimer = setTimeout(() => resolveSilent('silent'), limit)
  }

  const armActivityCap = () => {
    if (cap) {
      clearTimeout(cap)
      cap = null
    }
    if (disposed || turnDone || awaitingUser.size > 0) return
    cap = setTimeout(() => resolveSilent('silent'), OC_ACTIVITY_CAP_MS)
  }

  const syncForms = async () => {
    try {
      const forms = await ocListForms(ocId)
      if (disposed || turnDone || !Array.isArray(forms)) return
      for (const raw of forms) {
        const form = parseOcForm(raw)
        if (!form || awaitingUser.has(`form:${form.id}`)) continue
        awaitingUser.add(`form:${form.id}`)
        hooks.question?.(form)
        armSilence()
        armActivityCap()
      }
    } catch {}
  }

  const onEvent = (e: OcEvent) => {
    const d = e.data || {}
    if (extractOcEventSessionId(d) !== ocId) return
    rebindCount = 0
    switch (e.type) {
      case 'session.text.started':
      case 'session.reasoning.started':
      case 'session.step.started': {
        hasActivity = true
        retryAtMs = null
        if (!started) {
          hooks.start()
          started = true
        }
        break
      }
      case 'session.text.delta': {
        retryAtMs = null
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
        retryAtMs = null
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
        retryAtMs = null
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
      case 'session.tool.input.delta':
      case 'session.tool.input.ended': {
        retryAtMs = null
        const id = String(d.id ?? '')
        if (id) {
          activeTools.add(id)
          hasActivity = true
        }
        break
      }
      case 'session.tool.called': {
        retryAtMs = null
        const id = String(d.id ?? '')
        if (!id) break
        activeTools.add(id)
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
        if (toolNames.get(id) === 'question') awaitingUser.clear()
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
      case 'session.retry.scheduled': {
        const at = typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : Date.now() + 60_000
        retryAtMs = at
        hasActivity = true
        break
      }
      case 'session.compaction.started':
      case 'session.compaction.delta': {
        compacting = true
        hasActivity = true
        break
      }
      case 'session.compaction.ended': {
        compacting = false
        hasActivity = true
        break
      }
      case 'permission.asked': {
        const permId = String(d.id ?? '')
        if (permId) awaitingUser.add(`perm:${permId}`)
        hooks.permission({
          id: permId,
          action: String(d.action ?? ''),
          resources: Array.isArray(d.resources) ? d.resources.map(String) : [],
          message: typeof d.message === 'string' ? d.message : undefined,
        })
        break
      }
      case 'permission.replied': {
        const permId = String(d.requestID ?? d.id ?? '')
        if (permId) awaitingUser.delete(`perm:${permId}`)
        break
      }
      case 'form.created': {
        const form = parseOcForm(d.form)
        if (form) {
          awaitingUser.add(`form:${form.id}`)
          hasActivity = true
          hooks.question?.(form)
        }
        break
      }
      case 'form.replied':
      case 'form.cancelled': {
        const fid = String(d.id ?? '')
        if (fid) {
          awaitingUser.delete(`form:${fid}`)
          hooks.questionResolved?.(fid)
        }
        break
      }
      case 'session.execution.succeeded':
        turnDone = true
        break
      case 'session.execution.interrupted':
        turnDone = true
        if (errorMsg) failed = true
        break
      case 'session.execution.failed':
        turnDone = true
        failed = true
        errorMsg =
          typeof d.error === 'string'
            ? d.error
            : d.error !== null && d.error !== undefined
              ? JSON.stringify(d.error).slice(-160)
              : 'The turn failed'
        break
      case 'session.error':
        errorMsg = typeof d.error === 'string' ? d.error : errorMsg
        break
      case 'session.idle':
        if (hasActivity && !turnDone) {
          turnDone = true
          if (errorMsg) failed = true
        }
        break
      default:
        break
    }
    armSilence()
    armActivityCap()
    if (turnDone) finishOnce()
  }

  let streamErr: unknown = null
  const openStreamLeg = (): { promise: Promise<'dropped'>; controller: AbortController } => {
    const controller = new AbortController()
    attemptController = controller
    streamErr = null
    const promise = new Promise<'dropped'>((resolve) => {
      ocStream(onEvent, controller.signal, () => armActivityCap())
        .then(() => resolve('dropped'))
        .catch((e: unknown) => {
          streamErr = e
          resolve('dropped')
        })
    })
    return { promise, controller }
  }

  const makeSilentLeg = () =>
    new Promise<'silent'>((resolve) => {
      resolveSilent = resolve
    })

  cancelPoll = setInterval(() => {
    if (isCancelled?.()) resolveSilent('silent')
  }, 500)

  let firstStream = openStreamLeg()

  try {
    if (opts.command) {
      await ocRunCommand(ocId, opts.command.name, opts.command.text)
    } else {
      await ocPrompt(ocId, text)
    }
  } catch (e) {
    finishOnce()
    throw e instanceof Error ? e : new Error(String(e))
  }
  hooks.start()
  started = true
  armSilence()
  armActivityCap()
  void syncForms()

  // Keep re-attaching SSE whenever OpenCode confirms the session is still running
  // (long tool writes, reasoning pauses, transient mobile socket drops).
  let currentStream = firstStream
  while (!turnDone && !disposed) {
    const silentLeg = makeSilentLeg()
    const winner = await Promise.race([currentStream.promise, silentLeg])
    currentStream.controller.abort()
    if (turnDone || isCancelled?.() || disposed) {
      if (isCancelled?.()) failed = false
      break
    }

    await syncForms()
    const activeMap = await ocActiveSessions().catch(() => null)
    const isActive = activeMap ? activeMap[ocId]?.type === 'running' : null
    const sessionInfo = isActive === true ? null : await ocGetSession(ocId).catch(() => null)

    const decision = decideOcDisconnectAction({
      cancelled: !!isCancelled?.(),
      turnDone,
      winner,
      hasActivity,
      lastSilenceLimitMs,
      pendingFormCount: awaitingUser.size,
      sessionActive: isActive,
      sessionOutcome: sessionInfo?.outcome,
      sessionIdle: sessionInfo?.time?.idle != null,
      rebindCount,
      existingError: errorMsg,
      streamErrorText: streamErr ? describeOcError(streamErr) : undefined,
    })

    if (decision.kind === 'reconnect') {
      if (decision.countSilentRebind) rebindCount++
      log('info', 'opencode', `re-attaching SSE for ${ocId} (${decision.reason})`)
      armSilence()
      armActivityCap()
      await new Promise((r) => setTimeout(r, 250))
      if (turnDone || disposed || isCancelled?.()) break
      currentStream = openStreamLeg()
      continue
    }

    if (decision.kind === 'complete') {
      if (decision.syncHistory) {
        try {
          const hist = mapOcHistory((await ocHistory(ocId)) ?? [])
          const last = [...hist].reverse().find((r) => r.role === 'assistant')
          if (last) {
            if (last.text && last.text.startsWith(finalText) && last.text.length > finalText.length) {
              const tail = last.text.slice(finalText.length)
              finalText += tail
              hooks.text(tail)
            } else if (!finalText && last.text) {
              finalText = last.text
              hooks.text(last.text)
            }
            for (const t of last.tools ?? []) {
              if (!toolNames.has(t.id)) {
                hooks.tool(t.id, t.name, t.ok ? 'done' : 'failed')
              }
            }
          }
        } catch {}
      }
      turnDone = true
      failed = decision.failed
      errorMsg = decision.errorMsg ?? errorMsg
      break
    }

    failed = true
    errorMsg = decision.message
    break
  }

  finishOnce()
  if (!turnDone && isCancelled?.()) {
    hooks.complete(finalText, false)
    return
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

// The pure mapper lives in ./ocHistory (no RN imports) so the script suite can
// test it; re-exported here for chat.ts and the drawer's existing imports.
export { mapOcHistory, type OcHistoryRow, type OcHistorySegment } from './ocHistory'

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
