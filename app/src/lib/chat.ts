import { atom, computed } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppState } from 'react-native'
import { rpc, onEvent, onServerRequest, getClient, isConnected, connConfig } from './gateway'
import { getEmbeddedGateway } from './hermesRuntime'
import { log } from './log'
import { notifyLocal, setBadge } from './push'
import { bindLiveId, liveIdFor, sessionRows, sessionListComplete, toMs, upsertOptimisticRow, patchRowTitle, bumpSessionActivity } from './sessionList'
import { hookModelState, noteSessionInfo } from './modelState'
import { markAttention, clearAttention, pushToast, chatTabFocused, pendingOpenStoredId, type AttentionKind } from './attention'
import { clearDraft, draftFor, setDraft } from './drafts'
import { sendQueue, peekQueued, removeQueued, clearSendQueue, queueFor, enqueueSend, type QueuedSend } from './sendQueue'
import { extractMedia, isDataUrlPath, joinedTextOf, appendRefText, stripMediaFromText, mediaSegment } from './media'
import { processAttachments, detachImages, type PendingAttachment } from './mediaSend'
// Type-only: erased at runtime, so chat.ts stays free of slash.ts's atom graph
// (chat.ts already cannot load in plain node — react-native/AsyncStorage at
// import time — and this keeps it that way).
import type { CommandMeta } from './slash'

// ── Types ──────────────────────────────────────────────────────────────────

/** One block of a message's content, in order (both roles). */
export interface ChatSegment {
  kind: 'thinking' | 'text' | 'media'
  /** Media segments always carry '' — every `.text` reader stays safe. */
  text: string
  /** thinking only — ms timestamp of the segment's first delta. */
  startedAt?: number
  /** thinking only — raw chars received (text is capped; this isn't). */
  chars?: number
  /** thinking only — frozen "8s" elapsed once the segment ends. */
  meta?: string
  // ── media only ──
  mediaType?: 'image' | 'video' | 'audio' | 'file'
  /** Gateway-absolute path (/api/files/* URLs are built from it); '' on an
   *  optimistic user row until upload completes (then localUri renders). */
  path?: string
  name?: string
  size?: number
  mime?: string
  /** Receive side: the gateway can no longer serve the path → error tile. */
  state?: 'ok' | 'missing'
  /** Send side only: the local file while the gateway path doesn't exist
   *  yet. Never set on receive-side segments. */
  localUri?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** Full answer text (all text segments joined) — what copy/speak/search use. */
  text: string
  /** Assistant content in order: thinking blocks interleave with the text
   *  they precede. `text` is the joined text segments, kept in sync. */
  segments?: ChatSegment[]
  streaming?: boolean
  ts: number
  status?: 'ok' | 'failed'
  error?: string
  /** Command output card label — set once at row creation by
   *  pushLocalMessage, never mutated afterwards (terminal write-once rows).
   *  Absent on user bubbles, stream rows, and server-resumed history, which
   *  all keep rendering exactly as before. */
  cmd?: CommandMeta
}

export interface ToolItem {
  id: string
  name: string
  preview?: string
  status: 'running' | 'done' | 'failed'
  durationS?: number
}

export interface TodoItem {
  text: string
  done?: boolean
}

/** A live server->client question (approval / clarify / sudo / secret). */
export interface PendingRequest {
  /** The `srq-…` id. Answering is a JSON-RPC response frame carrying this id. */
  id: string
  method: 'approval' | 'clarify' | 'sudo' | 'secret'
  sessionId: string
  /** approval */
  command?: string
  description?: string
  choices?: string[]
  allowPermanent?: boolean
  allowSession?: boolean
  smartDenied?: boolean
  toolName?: string
  /** clarify */
  question?: string
  options?: string[]
  questions?: Array<{ qid: string; question?: string; choices?: string[]; multi_select?: boolean }>
  /** sudo / secret */
  prompt?: string
  envVar?: string
  replayed?: boolean
}

/** Everything the chat screen renders for one session. */
export interface SessionState {
  /** Live gateway session id (changes on every resume; used for RPCs + events). */
  id: string
  /** Durable id in the gateway's store (used to resume in a later app launch). */
  storedId: string
  /** Wall-clock ms this session was created locally, for ordering chats
   *  before the server's `started_at` is known. (Event-seq watermarks for
   *  reconnect replay live in JsonRpcGatewayClient — storing a per-event seq
   *  here re-rendered the UI at event rate, and the gateway's per-session
   *  counter is meaningless across conversations anyway.) */
  createdAtMs: number
  title: string
  messages: ChatMessage[]
  tools: ToolItem[]
  todos: TodoItem[]
  usage: string
  busy: boolean
  /**
   * The backend released this live session (idle timeout / LRU evict). The
   * transcript is still on screen but the handle is dead; the next send
   * transparently resumes it from its stored id.
   */
  detached?: boolean
  /**
   * The optimistic new-chat window: the entry lives under a temp key with a
   * pseudo stored id (`new:…`) while session.create is in flight. In-memory
   * only — never persisted, and cleared by the re-key when the real session
   * lands. A provisional entry must never be handed to an RPC; resolve it
   * through `activeLiveId()` / `ensureSession()` instead.
   */
  provisional?: boolean
}

const EMPTY: SessionState = {
  id: '',
  storedId: '',
  createdAtMs: 0,
  title: '',
  messages: [],
  tools: [],
  todos: [],
  usage: '',
  busy: false,
}

// ── Storage keys ───────────────────────────────────────────────────────────

/** The last session we were in, so relaunch lands back in the same conversation. */
const LAST_SESSION_KEY = 'hermes.activeSession.v1'
/** live session id -> stored session id, so a relaunch can resume it. */
const STORED_ID_MAP_KEY = 'hermes.storedIdMap.v1'
export const OUTBOX_KEY = 'hermes.outbox.v1'
const transcriptKey = (sessionId: string) => `hermes.transcript.${sessionId}.v1`
/** Transcripts are keyed by the DURABLE stored id — the live id is re-minted
 *  on every resume, so a key taken from it strands the blob: writes land
 *  under this run's live id, and after a restart nothing reads that key
 *  again. The `.v2` suffix (not just a new key derivation) guarantees a
 *  stored-keyed entry can never collide with a legacy live-keyed `.v1`
 *  entry; `migrateV1Transcript` moves the old ones across lazily. */
const transcriptV2Key = (storedId: string) => `hermes.transcript.${storedId}.v2`

export { LAST_SESSION_KEY as SESSION_KEY, STORED_ID_MAP_KEY }

const MAX_MESSAGES = 300
const MAX_TOOLS = 50
const MAX_OUTBOX = 20

// ── Store ──────────────────────────────────────────────────────────────────

/** Every session this app has touched, keyed by LIVE session id. */
export const sessionsById = atom<Record<string, SessionState>>({})
/** Which session the chat screen is showing. */
export const activeSession = atom<string | null>(null)
/** The active session's live id — the thing you pass to every scoped RPC. */
export const activeSessionId = computed(activeSession, id => (id && sessionsById.get()[id] ? id : null))
/** Server requests awaiting an answer, grouped by the session they block. */
const pendingBySession = atom<Record<string, PendingRequest[]>>({})
/** Queued prompts that could not be sent yet (offline). */
/** One outbox entry: text composed offline, pinned to the chat it was
 *  composed for (BUG-008). `storedId: ''` = legacy unpinned entry from an
 *  older install — flushed with the old active-chat contract. */
export interface OutboxItem {
  storedId: string
  text: string
}
export const outbox = atom<OutboxItem[]>([])

const view = computed([sessionsById, activeSession], (map, id): SessionState =>
  (id && map[id]) || EMPTY,
)

export const messages = computed(view, (s) => s.messages)
export const tools = computed(view, (s) => s.tools)
export const todos = computed(view, (s) => s.todos)
export const usage = computed(view, (s) => s.usage)
export const agentBusy = computed(view, (s) => s.busy)
export const activeTitle = computed(view, (s) => s.title)

/**
 * `session.list` returns DURABLE (stored) ids while every RPC and event is
 * keyed by the LIVE id. The session list has to bridge the two, so expose the
 * active session's stored id.
 */
export const activeStoredId = computed(view, (s) => s.storedId)

/**
 * Stored ids whose visible chat is still being fetched — a placeholder with
 * no cached transcript yet, waiting on the session.resume round-trip. The
 * chat screen renders a loading state for these instead of the new-chat
 * starters, so a slow first open never reads as "a brand-new empty chat".
 */
export const sessionLoadings = atom<Record<string, true>>({})

function setSessionLoading(storedId: string | undefined, on: boolean) {
  if (!storedId || isPseudoStoredId(storedId)) return
  const cur = sessionLoadings.get()
  if (on) {
    if (!cur[storedId]) sessionLoadings.set({ ...cur, [storedId]: true })
  } else if (cur[storedId]) {
    const next = { ...cur }
    delete next[storedId]
    sessionLoadings.set(next)
  }
}

/** The question blocking the session the user is looking at, if any. */
export const pendingRequest = computed([pendingBySession, activeSession], (map, id): PendingRequest | null => {
  if (!id) return null
  const list = map[id]
  return list && list.length ? list[0] : null
})

/** How many questions are waiting across ALL sessions — drives the tab badge. */
export const pendingCount = computed(pendingBySession, map =>
  Object.values(map).reduce((n, l) => n + (l?.length ?? 0), 0),
)

/** True when any session has work in flight. */
export const anyBusy = computed(sessionsById, map => Object.values(map).some((s) => s.busy))

/** Stored ids of sessions with a turn running — for the session list. */
export const busyStoredIds = computed(sessionsById, map =>
  Object.values(map)
    .filter((s) => s.busy)
    .map((s) => s.storedId)
    .filter(Boolean),
)

/** Stored ids of sessions with an unanswered question — for the session list. */
export const pendingStoredIds = computed([sessionsById, pendingBySession], (map, pend): string[] => {
  const out: string[] = []
  for (const [liveId, list] of Object.entries(pend)) {
    if (list?.length) {
      const stored = map[liveId]?.storedId
      if (stored) out.push(stored)
    }
  }
  return out
})

// ── Shell-facing summary keys ───────────────────────────────────────────────
//
// flushStreams re-roots sessionsById on every 33ms token batch (patchSession),
// and every array/map computed over it mints a fresh identity per evaluation —
// nanostores notifies on !Object.is, so subscribers like the always-mounted
// ScreenShell (and the mounted-forever Sidebar it feeds) re-rendered at the
// full flush rate all through a streaming turn. These string computeds carry
// only shell-relevant fields: an identical string across message-only flushes
// bails on Object.is, so the shell re-renders at real turn edges, title
// changes, and chat-list changes — never per token batch. Message arrays are
// still read fresh via sessionsById.get()/listen (ref-read) where needed.

/** Everything the drawer/shell derive from the session map, folded into one
 *  comparable string: the key set (sessions added/removed via their live ids)
 *  plus each entry's title/busy/storedId/createdAtMs. */
export const sessionsSummaryKey = computed(sessionsById, (map) =>
  Object.entries(map)
    .map(([id, s]) => `${id}|${s.title ?? ''}|${s.busy ? 1 : 0}|${s.storedId ?? ''}|${s.createdAtMs ?? 0}`)
    .sort()
    .join(';'),
)

/** busyStoredIds as a stable string — same content, identity that survives
 *  flushes that don't flip a busy flag. */
export const busyStoredKey = computed(sessionsById, (map) =>
  Object.values(map)
    .filter((s) => s.busy)
    .map((s) => s.storedId)
    .filter(Boolean)
    .sort()
    .join(','),
)

/** Messages queued for the chat on screen (composed while a turn ran). */
export const activeQueue = computed([sendQueue, activeStoredId], (map, stored): QueuedSend[] =>
  (stored && map[stored]) || [],
)

// ── Mascot moments ─────────────────────────────────────────────────────────
// One-shot edges the mascot waterfall consumes (useMochiState). Every atom is
// sid-stamped: the hook accepts a moment only when `sid` matches the session
// the user is looking at AT LAND TIME (a background chat's completion must
// not animate the foreground mascot).

/** Turn-shape moments: 'success' is promoted to a displayed 'celebration' by
 *  the hook when its own busy-start timestamp says the turn ran ≥30s. */
export const mochiMoment = atom<{
  kind: 'success' | 'error' | 'celebration' | 'apologetic' | 'greeting'
  sid: string
  at: number
} | null>(null)

/** A user prompt left the composer — sendPrompt is the single funnel (direct
 *  sends AND queued heads via maybeFlushQueue). Thank-you/shy regexes and the
 *  task-received perk both read this. */
export const mochiSent = atom<{ text: string; sid: string; at: number } | null>(null)

/** The chat on screen has had its live handle released (session.reclaimed) —
 *  the mascot's low-battery state. Keyed by the ACTIVE live id: sessionsById
 *  is keyed by live ids, and a stored id can never index it. */
export const activeDetached = computed([sessionsById, activeSession], (m, id) =>
  !!(id && m[id]?.detached),
)

/** Failure strip for the chat screen. The optimistic switch/create already
 *  put the user ON the target chat when the RPC fails, so the failure must
 *  surface there (tap to retry) — not in an Alert on the screen they just
 *  left. Cleared at the top of every switch/new-chat attempt and on success. */
export const chatBanner = atom<{ text: string; retry?: () => void } | null>(null)

let uid = 0
const nid = () => `m${Date.now()}_${uid++}`

// ── Helpers ────────────────────────────────────────────────────────────────

function textOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    return v
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
          if (typeof o.content === 'string') return o.content
        }
        return ''
      })
      .join('')
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

/** Mutate the active session's state. No-ops when nothing is active. */
function patchActive(patch: Partial<SessionState>) {
  const id = activeSession.get()
  if (!id) return
  const map = sessionsById.get()
  const cur = map[id]
  if (!cur) return
  sessionsById.set({ ...map, [id]: { ...cur, ...patch } })
}

// Exported for the drawer's rename flow (BUG-006): a successful manual
// rename patches the open chat's in-memory title so the header updates
// without waiting for an event echo or the next list poll.
export function patchSession(id: string, patch: Partial<SessionState>) {
  const map = sessionsById.get()
  const cur = map[id]
  if (!cur) return
  sessionsById.set({ ...map, [id]: { ...cur, ...patch } })
}

function makeSession(id: string, storedId: string, title = '', createdAtMs = Date.now()): SessionState {
  return { ...EMPTY, id, storedId, title: title || 'New chat', createdAtMs }
}

/** The map key of whichever entry currently represents a stored id: the
 *  bound live id's entry if it exists, else the optimistic `pending:`
 *  placeholder. Cache hydration patches THIS key — patching the stored id
 *  itself would silently no-op (no entry is ever keyed by it). */
function entryKeyFor(storedId: string): string {
  const map = sessionsById.get()
  const live = liveIdFor(storedId)
  if (live && map[live]) return live
  if (map[`pending:${storedId}`]) return `pending:${storedId}`
  return live ?? `pending:${storedId}`
}

// ── Stream batching ────────────────────────────────────────────────────────
//
// `thinking.delta` / `reasoning.delta` / `message.delta` arrive coalesced by
// the gateway at ~30 Hz (its WS transport batches per 33 ms — see
// tui_gateway/ws.py `_TOKEN_COALESCE_S`). Streaming rows render as a single
// plain-Text node, so one store patch per server flush batch is cheap and the
// stream reads like the CLI's per-token output. The buffer exists to absorb
// burst-delivered frames into one render; terminal events flush synchronously.

const FLUSH_MS = 33

interface StreamBuf {
  thinking: string
  text: string
  dirty: boolean
}
const streamBufs = new Map<string, StreamBuf>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function queueStream(sessionId: string, kind: 'thinking' | 'text', delta: string) {
  let buf = streamBufs.get(sessionId)
  if (!buf) {
    buf = { thinking: '', text: '', dirty: false }
    streamBufs.set(sessionId, buf)
  }
  if (kind === 'thinking') buf.thinking += delta
  else buf.text += delta
  buf.dirty = true
  if (!flushTimer) {
    flushTimer = setTimeout(flushStreams, FLUSH_MS)
  }
}

/** Apply buffered deltas now. Called by the timer and before every terminal patch. */
function flushStreams() {
  flushTimer = null
  for (const [sid, buf] of streamBufs) {
    if (!buf.dirty) continue
    buf.dirty = false
    const thinking = buf.thinking
    const text = buf.text
    buf.thinking = ''
    buf.text = ''
    const s = sessionsById.get()[sid]
    if (!s) continue
    if (!thinking && !text) continue

    // Both streams land on the tail assistant bubble as ORDERED segments:
    // think → answer, and a model that re-thinks after emitting text opens a
    // NEW thinking block below that output instead of appending to the first.
    let messages = [...s.messages]
    let i = messages.length - 1
    while (i >= 0 && !(messages[i].role === 'assistant' && messages[i].streaming)) i--
    if (i < 0) {
      messages.push({ id: nid(), role: 'assistant', text: '', streaming: true, ts: Date.now() })
      i = messages.length - 1
    }
    const m = messages[i]
    const segments: ChatSegment[] = m.segments ? [...m.segments] : (m.text ? [{ kind: 'text', text: m.text }] : [])

    if (thinking) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'thinking') {
        segments[segments.length - 1] = {
          ...last,
          text: (last.text + thinking).slice(-8000),
          chars: (last.chars ?? 0) + thinking.length,
        }
      } else {
        segments.push({ kind: 'thinking', text: thinking.slice(-8000), startedAt: Date.now(), chars: thinking.length })
      }
    }
    if (text) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'text') {
        segments[segments.length - 1] = { ...last, text: (last.text + text).slice(0, 32000) }
      } else {
        // Thinking resolved into output — freeze that block's meta at its end.
        if (last?.kind === 'thinking' && !last.meta) {
          segments[segments.length - 1] = { ...last, meta: formatThinkMeta(last.startedAt ?? 0, last.chars ?? 0) }
        }
        segments.push({ kind: 'text', text })
      }
    }

    const fullText = segments
      .filter((seg) => seg.kind === 'text')
      .map((seg) => seg.text)
      .join('')
    messages[i] = { ...m, text: fullText.slice(0, 32000), segments }
    patchSession(sid, { messages })
  }
}

/** Freeze the elapsed meta on thinking segments that never got text after them. */
function freezeThoughts(m: ChatMessage): ChatMessage {
  if (!m.segments?.some((seg) => seg.kind === 'thinking' && !seg.meta)) return m
  return {
    ...m,
    segments: m.segments.map((seg) =>
      seg.kind === 'thinking' && !seg.meta
        ? { ...seg, meta: formatThinkMeta(seg.startedAt ?? 0, seg.chars ?? seg.text.length) }
        : seg),
  }
}

/** "8s" elapsed timer for the thinking header — just the time, no token
 *  estimates (user call: speed readouts next to thinking read as noise).
 *  `now` is injectable so the live block can tick its elapsed counter on
 *  its own heartbeat. */
export function formatThinkMeta(startedAt: number, chars: number, now: number = Date.now()): string {
  if (!startedAt || !chars) return ''
  const secs = Math.max(1, Math.round((now - startedAt) / 1000))
  return `${secs}s`
}

// ── Transcript persistence (per session) ───────────────────────────────────

/** What a cached transcript holds. Legacy rows are a bare message array; the
 *  v1 envelope wraps messages plus the last turn's tool log (and, on v2
 *  keys, the chat title) so the collapsed "N tool calls" line and the header
 *  survive app restarts and session switches. */
interface PersistedTranscript {
  v: 1
  title?: string
  messages: ChatMessage[]
  tools: ToolItem[]
}

function sanitizeTools(raw: unknown): ToolItem[] {
  if (!Array.isArray(raw)) return []
  const ok = raw.filter(
    (t): t is ToolItem =>
      !!t && typeof t === 'object' && typeof (t as ToolItem).id === 'string' &&
      typeof (t as ToolItem).name === 'string' &&
      ((t as ToolItem).status === 'running' || (t as ToolItem).status === 'done' || (t as ToolItem).status === 'failed'),
  )
  return ok.map((t) => ({ ...t, status: t.status === 'running' ? 'done' as const : t.status })).slice(-MAX_TOOLS)
}

/** `new:…` pseudo stored id — the optimistic new-chat window's stand-in.
 *  There is nothing durable to key a transcript by yet. */
function isPseudoStoredId(storedId: string): boolean {
  return storedId.startsWith('new:')
}

const PERSIST_DEBOUNCE_MS = 500
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Trailing per-chat debounce (same pattern as drafts.ts / sendQueue.ts):
 * JSON.stringify of up to 300 messages × 32KB must not run on the swap or
 * turn-end tick — it hitched the exact frame the new transcript mounts on.
 * The timer re-resolves the CURRENT entry for the stored id when it fires,
 * so a chat that rotated (or was deleted) between schedule and fire is read
 * fresh, never from a stale snapshot. A hard kill loses ≤500ms of cache —
 * the server stays authoritative and resume rebuilds. Don't extend the
 * debounce casually.
 */
function schedulePersist(liveId: string) {
  const stored = sessionsById.get()[liveId]?.storedId
  if (!stored || isPseudoStoredId(stored)) return
  const t = persistTimers.get(stored)
  if (t) clearTimeout(t)
  persistTimers.set(stored, setTimeout(() => {
    persistTimers.delete(stored)
    const map = sessionsById.get()
    const live = liveIdFor(stored)
    const s = (live && map[live]) || map[`pending:${stored}`] || Object.values(map).find((x) => x.storedId === stored)
    if (s) void persistSession(s)
  }, PERSIST_DEBOUNCE_MS))
}

/** Cached-transcript hygiene: a send-side localUri points at a picker/cache
 *  file that is usually evicted by the next launch (its contract is
 *  send-side-only), and an unpaired inline data-URL segment is megabytes of
 *  base64 — neither belongs in an AsyncStorage blob. Server history is
 *  authoritative and re-supplies both on resume; the stripped data-URL
 *  segment keeps a `missing` marker so the offline cache shows a tile
 *  instead of silently trying to render a dropped path. */
function persistableMessages(list: ChatMessage[]): ChatMessage[] {
  return list.slice(-MAX_MESSAGES).map((m) => {
    if (!m.segments?.some((seg) => seg.kind === 'media' && (seg.localUri || isDataUrlPath(seg.path)))) return m
    return {
      ...m,
      segments: m.segments.map((seg) => {
        if (seg.kind !== 'media') return seg
        if (seg.localUri) return { ...seg, localUri: undefined }
        if (isDataUrlPath(seg.path)) return { ...seg, state: 'missing' as const }
        return seg
      }),
    }
  })
}

async function persistSession(s: SessionState) {
  const stored = s.storedId
  if (!stored || isPseudoStoredId(stored)) return
  try {
    const payload: PersistedTranscript = {
      v: 1,
      title: s.title,
      messages: persistableMessages(s.messages),
      tools: s.tools.slice(-MAX_TOOLS),
    }
    await AsyncStorage.setItem(transcriptV2Key(stored), JSON.stringify(payload))
  } catch {
    /* best effort */
  }
}

/**
 * One-time v1→v2 migration, run lazily when a v2 read misses. v1 blobs were
 * keyed two ways: by a LIVE id (which rotates on every resume — one stored
 * chat routinely has several v1 keys of different vintages, the FRESHEST
 * under the most recently mapped live id) and, from an interim build, by the
 * stored id itself. Scan newest-first so a stale vintage never paints over
 * the last one written, and remove EVERY v1 key mapped to this stored id.
 * Pairs that fell out of the 200-entry map cap are unreachable junk —
 * bounded and best-effort by design (no key enumeration API is in use).
 */
async function migrateV1Transcript(storedId: string): Promise<string | null> {
  if (!storedIdMapLoaded) await loadStoredIdMap()
  try {
    // Interim-build key: stored-keyed but still .v1 — freshest format.
    const interim = await AsyncStorage.getItem(transcriptKey(storedId))
    if (interim) {
      await AsyncStorage.setItem(transcriptV2Key(storedId), interim)
      await AsyncStorage.removeItem(transcriptKey(storedId))
      return interim
    }
    // Legacy: keyed by a live id that has since rotated. storedIdMap appends
    // per resume, so the LAST pair mapping here holds the newest write.
    const lives = Object.entries(storedIdMap)
      .filter(([, st]) => st === storedId)
      .map(([live]) => live)
      .reverse()
    let found: string | null = null
    for (const live of lives) {
      const raw = await AsyncStorage.getItem(transcriptKey(live))
      if (raw) {
        found = raw
        await AsyncStorage.setItem(transcriptV2Key(storedId), raw)
        break
      }
    }
    for (const live of lives) await AsyncStorage.removeItem(transcriptKey(live))
    return found
  } catch {
    return null
  }
}

/** Load a cached transcript for a chat we have no messages for yet. Takes
 *  the STORED id and patches whichever entry currently represents it
 *  (bound live id, or the `pending:` placeholder). Never clobbers: the
 *  guards re-read state after the await, so server history that lands first
 *  wins and the placeholder's cached messages survive only on a lazy
 *  session (server returned none). */
async function loadCachedTranscript(storedId: string) {
  if (sessionsById.get()[entryKeyFor(storedId)]?.messages.length) return
  try {
    let raw = await AsyncStorage.getItem(transcriptV2Key(storedId))
    if (!raw) raw = await migrateV1Transcript(storedId)
    if (!raw) return
    const parsed = JSON.parse(raw) as PersistedTranscript | Array<ChatMessage & { thinking?: string; thinkMeta?: string }>
    // Legacy transcripts are a bare message array; the wrapped form adds tools.
    const legacy = Array.isArray(parsed)
    const list = (legacy ? parsed : parsed.messages) as Array<ChatMessage & { thinking?: string; thinkMeta?: string }>
    if (!Array.isArray(list) || !list.length) return
    // Transcripts from the interim build carried a single `thinking` field —
    // normalize into ordered segments.
    const normalized = list.map((m) => {
      if (m.segments || typeof m.thinking !== 'string' || !m.thinking.trim()) return m
      const segments: ChatSegment[] = [{ kind: 'thinking', text: m.thinking, meta: m.thinkMeta }]
      if (m.text) segments.push({ kind: 'text', text: m.text })
      return { ...m, segments }
    })
    // Fire-time re-resolution: the entry may have been re-keyed (placeholder
    // consumed by the resume's merge) or filled (server history) while the
    // storage read was in flight.
    const target = entryKeyFor(storedId)
    const cur = sessionsById.get()[target]
    if (cur?.messages.length) return
    const patch: Partial<SessionState> = { messages: normalized.slice(-MAX_MESSAGES) }
    if (!legacy) patch.tools = sanitizeTools(parsed.tools)
    // The envelope's title fills placeholder headers only — a title from the
    // row or a session event is always fresher.
    if (!legacy && parsed.title && parsed.title !== 'New chat' && (cur?.title ?? 'New chat') === 'New chat') {
      patch.title = parsed.title
    }
    patchSession(target, patch)
  } catch {
    /* best effort */
  }
}

/** Restore just the persisted tool log — used when the server supplies the
 *  messages, since the tool log only ever existed on this device. */
async function loadCachedTools(storedId: string) {
  if (sessionsById.get()[entryKeyFor(storedId)]?.tools.length) return
  try {
    let raw = await AsyncStorage.getItem(transcriptV2Key(storedId))
    if (!raw) raw = await migrateV1Transcript(storedId)
    if (!raw) return
    const parsed = JSON.parse(raw) as PersistedTranscript | unknown[]
    if (Array.isArray(parsed)) return
    const target = entryKeyFor(storedId)
    if (sessionsById.get()[target]?.tools.length) return
    patchSession(target, { tools: sanitizeTools(parsed.tools) })
  } catch {
    /* best effort */
  }
}

/** Delete every cached transcript belonging to a stored id: the v2 key, the
 *  interim stored-keyed v1, and any legacy live-keyed v1 still mapped. */
async function dropCachedTranscript(storedId: string) {
  try {
    await AsyncStorage.removeItem(transcriptV2Key(storedId))
    await AsyncStorage.removeItem(transcriptKey(storedId))
    for (const [live, st] of Object.entries(storedIdMap)) {
      if (st === storedId) await AsyncStorage.removeItem(transcriptKey(live))
    }
  } catch {
    /* best effort */
  }
}

// ── Stored-id map (live id -> durable id, survives relaunch) ───────────────

let storedIdMap: Record<string, string> = {}
/** Set once loadStoredIdMap has run, so callers (and the v1→v2 migration)
 *  can lazy-load on first need instead of keying off "map looks empty". */
let storedIdMapLoaded = false

async function loadStoredIdMap() {
  try {
    const raw = await AsyncStorage.getItem(STORED_ID_MAP_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>
      if (parsed && typeof parsed === 'object') storedIdMap = parsed
    }
  } catch {
    storedIdMap = {}
  }
  storedIdMapLoaded = true
}

async function rememberStoredId(liveId: string, storedId: string) {
  if (!liveId || !storedId || storedIdMap[liveId] === storedId) return
  // BUG-064: delete-then-set refreshes the key's insertion order — a plain
  // assignment kept an old key in its original slot, so the 200-cap evicted
  // long-lived ACTIVE pairs while stale ones survived (and evictions strand
  // their legacy v1 transcript blobs forever).
  delete storedIdMap[liveId]
  storedIdMap[liveId] = storedId
  // Bound the map so it can't grow forever.
  const entries = Object.entries(storedIdMap)
  if (entries.length > 200) storedIdMap = Object.fromEntries(entries.slice(-200))
  try {
    await AsyncStorage.setItem(STORED_ID_MAP_KEY, JSON.stringify(storedIdMap))
  } catch {
    /* best effort */
  }
}

export function storedIdFor(liveId: string): string | undefined {
  return storedIdMap[liveId]
}

// ── Outbox ─────────────────────────────────────────────────────────────────

async function persistOutbox() {
  try {
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.get()))
  } catch {
    /* best effort */
  }
}

function enqueueOffline(text: string, storedId = '') {
  outbox.set([...outbox.get(), { storedId, text }].slice(0, MAX_OUTBOX))
  void persistOutbox()
}

export async function loadOutbox() {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY)
    if (raw) {
      const list = JSON.parse(raw) as unknown
      if (Array.isArray(list)) {
        // Accept both shapes: legacy `string[]` entries (storedId '') and
        // pinned `OutboxItem[]` entries.
        const items: OutboxItem[] = []
        for (const x of list) {
          if (typeof x === 'string') items.push({ storedId: '', text: x })
          else if (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string') {
            const rawStored = (x as { storedId?: unknown }).storedId
            items.push({ storedId: typeof rawStored === 'string' ? rawStored : '', text: (x as { text: string }).text })
          }
        }
        outbox.set(items.slice(0, MAX_OUTBOX))
      }
    }
  } catch {
    /* best effort */
  }
}

/** BUG-019: clear the in-memory outbox WITHOUT touching storage — the
 *  backend-identity switch runs this before re-reading, so a previous
 *  machine's unsent texts never survive into the new pairing (a failed
 *  shelf reload must not leave the old machine's texts live in the atom). */
export function resetOutbox() {
  outbox.set([])
}

export async function flushOutbox(): Promise<void> {
  // BUG-002: send one at a time and remove each item BEFORE its send — the
  // old clear-then-iterate dropped every item after the first failure (its
  // catch re-enqueued only the failing text; the caller swallows the throw).
  // Items after a failure now simply stay queued. Single enqueue layer
  // (BUG-008): a failed send is re-enqueued by sendPrompt's own offline
  // path, never re-added here.
  while (outbox.get().length) {
    const [item, ...rest] = outbox.get()
    outbox.set(rest)
    await persistOutbox()
    try {
      if (item.storedId) {
        // Pinned (BUG-008): deliver to the chat it was composed for, never
        // to whichever chat happens to be active at flush time.
        const live = Object.values(sessionsById.get()).find((s) => s.storedId === item.storedId)?.id
        if (live) {
          await sendPrompt(item.text, { session: live })
        } else {
          // Not tracked (cold boot / evicted handle): a quiet resume brings
          // the handle back; a not-found answer means the chat is gone.
          try {
            const fresh = await resumeShared(item.storedId)
            await sendPrompt(item.text, { session: fresh.sessionId })
          } catch (resumeErr) {
            if (!isSessionNotFound(resumeErr)) throw resumeErr
            log('warn', 'chat', `outbox item dropped — chat ${item.storedId} no longer exists`)
          }
        }
      } else {
        await sendPrompt(item.text)
      }
      // The stale 'failed' row from the original offline failure would
      // duplicate the freshly delivered message — drop it (BUG-008).
      dropMatchingFailedRow(item.storedId, item.text)
    } catch (err) {
      // sendPrompt's offline path re-enqueued the failed item; if it threw
      // for a reason that did NOT re-enqueue (e.g. the pinned guard), put
      // it back so nothing is lost. Either way, stop — remaining items
      // stay queued for the next flush.
      if (!outbox.get().some((x) => x.text === item.text && x.storedId === item.storedId)) {
        outbox.set([...outbox.get(), item].slice(0, MAX_OUTBOX))
        void persistOutbox()
      }
      throw err
    }
  }
}

/** Remove the first failed user row matching a just-flushed outbox item so
 *  the transcript doesn't show the text twice (failed row + sent row). */
function dropMatchingFailedRow(storedId: string, text: string) {
  const entry = Object.values(sessionsById.get()).find((s) => s.storedId === storedId)
  if (!entry) return
  const idx = entry.messages.findIndex((m) => m.role === 'user' && m.status === 'failed' && m.text === text)
  if (idx < 0) return
  patchSession(entry.id, { messages: entry.messages.filter((_, i) => i !== idx) })
}

// ── Queued attachments (memory-only) ───────────────────────────────────────
//
// Messages composed while a turn runs ride the busy-queue; attachments
// composed with them ride THIS map, keyed by the queued send's id. It is
// deliberately not persisted — a PendingAttachment points at a local file
// uri and a gateway upload that have no meaning after a restart (sendQueue
// storage stays {id,text,ts}, and loadSendQueue drops the empty-text items
// attachment-only sends produce). The queue strip's remove/edit/steer
// actions (chat.tsx) and a successful flush are the cleanup points.

const queuedAttachments = new Map<string, PendingAttachment[]>()

/** Hand a queued message's attachments over to chat.ts (composer → queue). */
export function setQueuedAttachments(queuedId: string, attachments: PendingAttachment[]): void {
  if (attachments.length) queuedAttachments.set(queuedId, attachments)
  else queuedAttachments.delete(queuedId)
}

/** Take (and forget) a queued message's attachments — the queue strip's
 *  Edit flow moves them back into the composer so nothing is silently lost. */
export function takeQueuedAttachments(queuedId: string): PendingAttachment[] {
  const list = queuedAttachments.get(queuedId)
  queuedAttachments.delete(queuedId)
  return list ?? []
}

/** Build a user row's ordered segments: the words, then each attachment as a
 *  media segment (localUri while there is no gateway path yet). */
function userSegmentsFor(text: string, attachments: readonly PendingAttachment[]): ChatSegment[] {
  const segments: ChatSegment[] = []
  if (text) segments.push({ kind: 'text', text })
  for (const att of attachments) {
    segments.push(
      mediaSegment({
        mediaType: att.kind,
        path: att.path ?? '',
        name: att.name,
        size: att.size,
        mime: att.mime,
        localUri: att.uri,
      }),
    )
  }
  return segments
}

/** After upload: bind each media segment to its gateway path (segments are
 *  matched by the attachment's local uri, stable across the upload). */
function patchRowMediaPaths(
  liveId: string,
  rowId: string,
  attachments: readonly PendingAttachment[],
  pathsById: Record<string, string>,
) {
  const byUri: Record<string, string> = {}
  for (const att of attachments) {
    const p = pathsById[att.id]
    if (p) byUri[att.uri] = p
  }
  if (!Object.keys(byUri).length) return
  const s = sessionsById.get()[liveId]
  const idx = s?.messages.findIndex((m) => m.id === rowId) ?? -1
  if (!s || idx < 0) return
  const m = s.messages[idx]
  if (!m.segments?.some((seg) => seg.kind === 'media')) return
  const messages = [...s.messages]
  messages[idx] = {
    ...m,
    segments: m.segments.map((seg) =>
      // Binding the path RETIRES the localUri: its contract is send-side-only
      // ("the local file while the gateway path doesn't exist yet"), and a
      // localUri that survives into the persisted transcript renders a dead
      // cache uri after the next restart instead of the durable path.
      seg.kind === 'media' && seg.localUri && byUri[seg.localUri]
        ? { ...seg, path: byUri[seg.localUri], localUri: undefined }
        : seg,
    ),
  }
  patchSession(liveId, { messages })
}

// ── Session lifecycle ──────────────────────────────────────────────────────

export interface ResumeResult {
  sessionId: string
  storedId: string
  messages: Array<Record<string, unknown>>
}

const CREATE_COLS = 120

/**
 * Create a fresh session. NOTE: the contract is `extra="forbid"` — passing an
 * unknown key (the old `rows`) is rejected with 4000 and the call fails, so
 * only ever send keys listed in SessionCreateParams.
 */

/** cwd override when the active connection is the on-phone embedded gateway. */
async function embeddedSessionCwd(): Promise<{ cwd?: string }> {
  try {
    const gw = await getEmbeddedGateway()
    const host = connConfig.get()?.host ?? ''
    if (!gw?.running || !gw.workspace || !host.startsWith('127.0.0.1')) return {}
    return { cwd: gw.workspace }
  } catch {
    return {}
  }
}

/** session.create with an embedded-only retry: an intermittent in-process
 * dispatch race can leave the first call unanswered (hermes 0.21.3
 * embedded; see embedded/MILESTONE-5.md). The abandoned attempt stays a
 * server-side draft and is reaped. Remote machines get a single call. */
async function createSessionRpc<T>(params: Record<string, unknown>): Promise<T> {
  const gw = await getEmbeddedGateway().catch(() => null)
  const embedded = !!gw?.running && (connConfig.get()?.host ?? '').startsWith('127.0.0.1')
  const timeoutMs = embedded ? 8000 : undefined
  try {
    return await rpc<T>('session.create', params, timeoutMs)
  } catch (e) {
    if (!embedded || !(e instanceof Error) || !/timeout/i.test(e.message)) throw e
    log('warn', 'chat', 'embedded session.create timed out once; retrying')
    return await rpc<T>('session.create', params, timeoutMs)
  }
}

export async function createSession(title?: string): Promise<ResumeResult> {
  const res = await createSessionRpc<{ session_id?: string; stored_session_id?: string; messages?: Array<Record<string, unknown>>; info?: { model?: string; provider?: string; reasoning_effort?: string } }>(
    // A create-time title is MANUAL authority server-side: it is applied at
    // the end of turn 1, clobbering the auto-title and permanently blocking
    // its upgrades. Only send one when the caller explicitly has a name;
    // "New chat" stays a client-side placeholder.
    // Embedded runtime: root the session in the on-phone workspace
    // (files/Moch/workspace) so file tools operate there (M5). Remote
    // machines keep their own cwd semantics.
    { ...(title ? { title } : {}), cols: CREATE_COLS, source: 'mobile', ...(await embeddedSessionCwd()) },
  )
  const id = res?.session_id
  if (!id) throw new Error('session.create returned no id')
  noteSessionInfo(res.info)
  const storedId = res.stored_session_id ?? id
  // Fire-and-forget: rememberStoredId's in-memory map update runs
  // synchronously; only the AsyncStorage write is async, and the visible
  // swap must not wait on it.
  void rememberStoredId(id, storedId)
  bindLiveId(storedId, id)
  // Show it in the drawer straight away rather than on the next session.list.
  upsertOptimisticRow(storedId, title || 'New chat')
  sessionsById.set({ ...sessionsById.get(), [id]: makeSession(id, storedId, title) })
  // Activation is the CALLERS' job (newChat re-keys its optimistic entry,
  // ensureSession sets explicitly after its two create tails) — an
  // unconditional set here would yank the screen back on a rapid double-tap.
  void AsyncStorage.setItem(LAST_SESSION_KEY, storedId)
  return { sessionId: id, storedId, messages: res.messages ?? [] }
}

/** Resume a stored session. Takes the DURABLE id (what `session.list` returns
 *  and what we persist), returns the LIVE id used for RPCs and events.
 *  Unconditional activation — only the boot path owns the screen this way.
 *  BUG-062: the exported wrapper had zero callers (boot goes through
 *  withBootPaint, switches through switchToSession) — removed; resumeShared
 *  is the primitive every path uses. */
async function runResume(storedId: string): Promise<ResumeResult> {
  const res = await rpc<{ session_id?: string; stored_session_id?: string; messages?: Array<Record<string, unknown>>; info?: { model?: string; provider?: string; reasoning_effort?: string }; running?: boolean; status?: string }>(
    'session.resume',
    { session_id: storedId, cols: CREATE_COLS },
  )
  const id = res?.session_id
  if (!id) throw new Error('session.resume returned no id')
  noteSessionInfo(res.info)
  const newStored = res.stored_session_id ?? storedId
  // Pre-bind state: the entry to carry over lives under the OLD live id (or
  // the optimistic placeholder), and bindLiveId below would overwrite the
  // very lookup that finds it.
  const oldLive = liveIdFor(newStored)
  const before = sessionsById.get()
  const prev = (oldLive ? before[oldLive] : undefined) ?? before[`pending:${storedId}`] ?? before[`pending:${newStored}`]
  void rememberStoredId(id, newStored)
  bindLiveId(newStored, id)

  // ONE synchronous merge — no await between the delete and the re-point:
  // `view` is `(id && map[id]) || EMPTY`, so straddling an await would blank
  // the chat screen for a frame. The placeholder keys are deleted here too
  // (they'd otherwise live forever as ghost duplicates of the merged entry —
  // double drawer rows, bogus liveIdOf hits) and the questions filed under
  // them are dropped: the backend replays open questions under the new live
  // id (the `replayed` flag exists for exactly that).
  const pendKey = `pending:${storedId}`
  const pendKey2 = `pending:${newStored}`
  const next = { ...sessionsById.get() }
  const pend = { ...pendingBySession.get() }
  let pendDirty = false
  for (const k of [oldLive, pendKey, pendKey2]) {
    if (!k || k === id) continue
    if (next[k]) delete next[k]
    if (pend[k]) {
      delete pend[k]
      pendDirty = true
    }
  }
  // Carry messages/tools/todos/title/usage/busy over from the previous
  // entry — a rotated live id must not land on an empty 'New chat' state.
  next[id] = {
    ...(prev ?? makeSession(id, newStored)),
    id,
    storedId: newStored,
    detached: false,
    provisional: false,
    // BUG-084: the resume payload reports whether a turn is mid-flight —
    // trust it. The client only ever set busy from its OWN sends, so a cold
    // re-entry (app restart / deep link / cold drawer row) into a running
    // chat rendered fully idle — no stop button, no live tool footer, no
    // drawer busy dot — until the next text delta. Older gateways omit the
    // field: keep the carried-over entry's value instead of forcing idle.
    busy: typeof res.running === 'boolean' ? res.running : (prev?.busy ?? false),
  }
  sessionsById.set(next)
  if (pendDirty) pendingBySession.set(pend)
  // Guarded re-point: only move the screen if the user is still looking at
  // this chat (its old live entry or its placeholder). A resume racing a
  // newer tap must never yank them back.
  const cur = activeSession.get()
  if (cur === oldLive || cur === pendKey || cur === pendKey2) activeSession.set(id)

  if (res.messages?.length) {
    // Restore the device-persisted tool log BEFORE applyHistory — its
    // persist would otherwise write the blob back with an empty tools list
    // and erase the log on every restart. Server history carries no tool
    // log; this line is what makes the collapsed chip survive a restart.
    await loadCachedTools(newStored)
    applyHistory(id, res.messages)
  } else {
    await loadCachedTranscript(newStored)
  }
  // Extra call is safe by construction: its busy/detached/pending guards
  // return unless this chat actually has a queued message and an idle handle.
  maybeFlushQueue(id)
  // Resume finished — whatever it painted (server history, or a lazy empty
  // session whose cached transcript just hydrated) is the real content now.
  setSessionLoading(storedId, false)
  setSessionLoading(newStored, false)
  return { sessionId: id, storedId: newStored, messages: res.messages ?? [] }
}

// One shared in-flight resume per stored id: a switch, a send racing the
// switch window, and the boot/deep-link paths must all await the SAME
// session.resume RPC — a second concurrent resume mints a second live
// handle and splits the history between them. Load-bearing, not an
// optimization.
const inflightResumes = new Map<string, Promise<ResumeResult>>()

/** Shared, deduped resume core — the one primitive every path that needs a
 *  live handle for a stored id goes through. */
/** Shared, deduped resume core — the one primitive every path that needs a
 *  live handle for a stored id goes through. Exported for surface-agnostic
 *  callers that must resolve a live id before a live-session RPC (BUG-006
 *  rename). */
export function resumeShared(storedId: string): Promise<ResumeResult> {
  const inflight = inflightResumes.get(storedId)
  if (inflight) return inflight
  const p = runResume(storedId).finally(() => {
    if (inflightResumes.get(storedId) === p) inflightResumes.delete(storedId)
  })
  inflightResumes.set(storedId, p)
  return p
}

/** Boot paint for a stored id: seed the placeholder + cached transcript and
 *  activate NOW, then resume — the screen shows the cached conversation
 *  before connect/resume completes, and the real live entry takes over when
 *  the RPC lands. */
async function withBootPaint(stored: string): Promise<ResumeResult> {
  const key = seedPlaceholder(stored)
  activeSession.set(key)
  setSessionLoading(stored, true)
  void loadCachedTranscript(stored)
  const r = await resumeShared(stored).catch((err: unknown) => {
    setSessionLoading(stored, false)
    throw err
  })
  // Unconditional: this path only runs with nothing else active — it owns
  // the screen by definition.
  activeSession.set(r.sessionId)
  clearAttention(r.storedId)
  void AsyncStorage.setItem(LAST_SESSION_KEY, r.storedId)
  return r
}

/** Boot: restore the last session, or create one. Safe to call repeatedly. */
export async function ensureSession(opts?: { create?: boolean }): Promise<string> {
  // BUG-013: look-only surfaces (the Models tab) pass create:false — merely
  // VISITING them must not mint a server-side session for an unsent chat
  // (the local-only invariant the chat screen deliberately upholds). They
  // get the provisional/live id or '' and skip session-scoped reads.
  const create = opts?.create !== false
  const current = activeSession.get()
  if (current) {
    const state = sessionsById.get()[current]
    // The optimistic new-chat window: creation is DEFERRED to the first
    // real action (send / model pick) — an unsent chat never exists on the
    // server and never shows in the saved list.
    if (state?.provisional) {
      if (!create) return current
      if (inflightCreate) return await inflightCreate
      const tempId = current
      const pseudo = state.storedId
      const p = runNewChat(tempId, pseudo).finally(() => {
        if (inflightCreate === p) inflightCreate = null
      })
      inflightCreate = p
      return await p
    }
    // A released session still has a usable stored id — bring it back rather
    // than letting the next send fail against a dead handle.
    if (state?.detached && state.storedId) {
      try {
        const r = await resumeShared(state.storedId)
        // Guarded: only re-point the screen if this chat is still the one on
        // it when the resume lands (the send still targets r.sessionId).
        if (activeStoredId.get() === r.storedId) activeSession.set(r.sessionId)
        return r.sessionId
      } catch (err) {
        // BUG-014: reattach failed (dead stored id after a serve reinstall,
        // or a resume-specific error). Silently minting a fresh session and
        // switching to it HIJACKED the screen mid-look AND rerouted the
        // in-flight send into an empty chat with the real error swallowed.
        // Fail loudly instead: sendPrompt's catch marks the user row failed
        // with THIS error and the user stays on the chat they were reading.
        log('warn', 'chat', `could not reattach released session: ${String(err)}`)
        throw err instanceof Error ? err : new Error(String(err))
      }
    }
    return current
  }

  if (!storedIdMapLoaded) await loadStoredIdMap()

  // A pending deep-link (notification/toast tap) resumes its ONE session;
  // a plain cold boot does NOT — the screen gets a local new chat instead
  // (openLocalChatIfNeeded), and the session is only created on first send.
  const po = pendingOpenStoredId.get()
  if (po && Date.now() - po.at <= 60_000) {
    pendingOpenStoredId.set(null)
    try {
      return (await withBootPaint(po.storedId)).sessionId
    } catch {
      /* fall through to a fresh chat */
    }
  }
  // BUG-013: nothing active and creating is off — report "none" instead of
  // minting a session for a surface that was merely visited.
  if (!create) return ''
  const r = await createSession()
  activeSession.set(r.sessionId)
  return r.sessionId
}

/**
 * The live id RPC-bearing callers should use RIGHT NOW: resolves the
 * optimistic windows (new-chat create, detached/placeholder switch) to a
 * real live id, awaiting the shared create/resume so no second RPC mints a
 * second handle. Throws when the window's RPC already failed.
 */
export async function activeLiveId(): Promise<string> {
  const cur = activeSession.get()
  const state = cur ? sessionsById.get()[cur] : undefined
  if (state?.provisional) {
    if (!inflightCreate) throw new Error('New chat is not ready')
    return await inflightCreate
  }
  if (state?.detached && state.storedId) {
    return (await resumeShared(state.storedId)).sessionId
  }
  if (cur) return cur
  return ensureSession()
}

// The optimistic new-chat window's in-flight create (resolves to the REAL
// live id). Two rapid New taps each get their own session (cleared only when
// still current); a stale awaiter just gets a valid session.
let inflightCreate: Promise<string> | null = null

/**
 * New chat, optimistically: the screen swaps to a placeholder THIS tick and
 * session.create runs in the background. The placeholder's pseudo stored id
 * (`new:…`) keys drafts/attention/sidebar-highlight for the window; on
 * success everything re-keys to the real ids in ONE synchronous set, so a
 * message typed and sent during the window lands in the NEW chat, never the
 * old one. Resolves to the real live id.
 */
export function newChat(): Promise<string> {
  chatBanner.set(null)
  // Sweep dead provisional windows (a failed create kept around for its
  // banner, a superseded double-tap) so they can't linger as ghost entries.
  const mapNow = sessionsById.get()
  const dead = Object.keys(mapNow).filter((k) => mapNow[k].provisional)
  if (dead.length) {
    const swept = { ...mapNow }
    const pend = { ...pendingBySession.get() }
    let pendDirty = false
    for (const k of dead) {
      delete swept[k]
      if (pend[k]) {
        delete pend[k]
        pendDirty = true
      }
    }
    sessionsById.set(swept)
    if (pendDirty) pendingBySession.set(pend)
  }
  const tempId = `pending:new:${nid()}`
  const pseudo = `new:${nid()}`
  sessionsById.set({ ...sessionsById.get(), [tempId]: { ...makeSession(tempId, pseudo), provisional: true } })
  activeSession.set(tempId)
  // Mascot greeting — latched by the hook at land time (activeSession ===
  // tempId right here), so it plays its full loop across runNewChat's re-key.
  mochiMoment.set({ kind: 'greeting', sid: tempId, at: Date.now() })
  // Fully LOCAL: no session.create until the first message (ensureSession
  // starts runNewChat then). An unsent new chat must not exist on the
  // server, and must not appear in the saved-chats list.
  return Promise.resolve(tempId)
}

/** Open the local new-chat window when the screen is staring at nothing —
 *  cold boot, a backend switch's cache purge. Skips when a chat is already
 *  on screen, a notification deep-link is pending, or a resume is in flight
 *  (opening over a landing resume would steal the screen). */
export function openLocalChatIfNeeded(): void {
  if (activeSession.get()) return
  const po = pendingOpenStoredId.get()
  if (po && Date.now() - po.at <= 60_000) return
  if (inflightResumes.size > 0) return
  void newChat().catch(() => {})
}

/** Background half of `newChat`: create the session, then re-key the
 *  placeholder to the real ids in one synchronous set (see newChat). */
async function runNewChat(tempId: string, pseudo: string): Promise<string> {
  try {
    const r = await createSession()
    // Re-key in ONE synchronous set: overlay whatever createSession seeded
    // with anything typed into the placeholder during the window.
    const map = sessionsById.get()
    const temp = map[tempId]
    const real = map[r.sessionId]
    const next = { ...map }
    delete next[tempId]
    next[r.sessionId] = {
      ...(real ?? makeSession(r.sessionId, r.storedId, 'New chat')),
      ...(temp ? { messages: temp.messages, tools: temp.tools, todos: temp.todos } : {}),
      title: temp?.title && temp.title !== 'New chat' ? temp.title : (real?.title ?? 'New chat'),
      id: r.sessionId,
      storedId: r.storedId,
      provisional: false,
    }
    sessionsById.set(next)
    const pend = { ...pendingBySession.get() }
    if (pend[tempId]) {
      // Questions filed under the temp key (backend omitted session_id)
      // are replayed under the real id; drop the orphan.
      delete pend[tempId]
      pendingBySession.set(pend)
    }
    if (activeSession.get() === tempId) activeSession.set(r.sessionId)
    // Migrate stored-keyed side state off the pseudo id: drafts, and the
    // queue (empty in practice for a fresh chat — migrate anyway).
    const d = draftFor(pseudo)
    if (d) {
      setDraft(r.storedId, d)
      clearDraft(pseudo)
    }
    for (const q of queueFor(pseudo)) enqueueSend(r.storedId, q.text)
    clearSendQueue(pseudo)
    return r.sessionId
  } catch (err) {
    chatBanner.set({
      text: "Couldn't start this chat — tap to retry",
      retry: () => {
        chatBanner.set(null)
        void newChat().catch(() => {})
      },
    })
    // Keep the placeholder while the user is still on it (the banner
    // retries); drop it if they moved on, so it can't ghost the drawer.
    const map = sessionsById.get()
    if (map[tempId] && activeSession.get() !== tempId) {
      const next = { ...map }
      delete next[tempId]
      sessionsById.set(next)
    }
    const pend = { ...pendingBySession.get() }
    if (pend[tempId]) {
      delete pend[tempId]
      pendingBySession.set(pend)
    }
    throw err
  }
}

/** Deterministic placeholder key for a not-yet-resumed chat — deterministic
 *  so a double-tap (or boot + deep-link racing) reuses ONE entry, and
 *  idempotent so it never clobbers messages already hydrated into it. */
function seedPlaceholder(storedId: string): string {
  const key = `pending:${storedId}`
  const map = sessionsById.get()
  if (map[key]) return key
  const row = sessionRows.get().find((r) => r.id === storedId)
  // detached: the live handle doesn't exist yet — a send during the window
  // quietly resumes through the shared core instead of firing a second RPC.
  sessionsById.set({
    ...map,
    [key]: {
      ...makeSession(key, storedId, row?.title || 'New chat', toMs(row?.started_at) || Date.now()),
      detached: true,
    },
  })
  return key
}

/**
 * Switch the chat screen to a session the user picked — optimistically, in
 * the tap tick. An in-memory hit reuses the whole entry (busy/tools/todos
 * ride along); a cold row seeds a placeholder carrying the row's title and
 * hydrates the cached transcript while the shared resume runs. Activation
 * when the RPC lands is guarded (only if this chat is still on screen), so a
 * rapid A→B tap is never yanked back to A. Server history REPLACES the
 * cached array wholesale (no duplicates); the cache survives only on a lazy
 * session whose resume returns no messages.
 */
export function switchToSession(storedId: string): Promise<string> {
  chatBanner.set(null)
  // Already there (a detached active chat falls through — the tap
  // re-attaches it).
  const curId = activeSession.get()
  const cur = curId ? sessionsById.get()[curId] : undefined
  if (cur && cur.storedId === storedId && !cur.detached && !cur.provisional) {
    clearAttention(storedId)
    return Promise.resolve(curId!)
  }
  const failSwitch = () => {
    chatBanner.set({
      text: "Couldn't open this chat — tap to retry",
      retry: () => {
        chatBanner.set(null)
        void switchToSession(storedId).catch(() => {})
      },
    })
  }
  const settle = (r: ResumeResult) => {
    // Guarded activation: the user may already have tapped a different chat.
    if (activeStoredId.get() === r.storedId) activeSession.set(r.sessionId)
    // The server may have re-pointed the stored id — persist what it
    // actually returned, not what we tapped.
    void AsyncStorage.setItem(LAST_SESSION_KEY, r.storedId)
    return r.sessionId
  }
  // In-memory hit: the whole entry is reused, so busy state, the tool log,
  // todos and scroll survive the switch; the resume is just a handle/history
  // refresh in the background.
  const live = liveIdFor(storedId)
  const hit = live ? sessionsById.get()[live] : undefined
  if (hit) {
    activeSession.set(live!)
    clearAttention(storedId)
    // A reused entry with content paints instantly; only an empty one
    // (detached, cache missed) needs the loading state while resume runs.
    setSessionLoading(storedId, !hit.messages.length)
    void AsyncStorage.setItem(LAST_SESSION_KEY, storedId)
    return resumeShared(storedId)
      .then(settle)
      .catch((err: unknown) => {
        // A detached hit that cannot re-attach leaves the user on a dead
        // transcript — banner it. A live hit only missed a refresh; the
        // offline banner already covers a dropped connection.
        setSessionLoading(storedId, false)
        if (hit.detached) failSwitch()
        throw err
      })
  }
  // Cold row: placeholder NOW, cached transcript hydrating, one shared resume.
  const key = seedPlaceholder(storedId)
  activeSession.set(key)
  clearAttention(storedId)
  setSessionLoading(storedId, true)
  void AsyncStorage.setItem(LAST_SESSION_KEY, storedId)
  void loadCachedTranscript(storedId)
  return resumeShared(storedId)
    .then(settle)
    .catch(async (err: unknown) => {
      setSessionLoading(storedId, false)
      if (isSessionNotFound(err)) {
        // BUG-029: the target doesn't exist (deleted elsewhere, stale
        // notification). The placeholder would otherwise sit under a
        // forever-failing retry banner — fall back to a local new chat
        // instead; the reconciliation sweep drops the placeholder.
        const fresh = await newChat().catch(() => '')
        return fresh || activeSession.get() || ''
      }
      // Keep the placeholder — it holds the cached transcript, so offline
      // reading still works; the banner offers the retry.
      failSwitch()
      throw err
    })
}

/** Forget a session locally (backend delete is the caller's job). */
export async function forgetSession(liveId: string) {
  const stored = sessionsById.get()[liveId]?.storedId
  const map = { ...sessionsById.get() }
  delete map[liveId]
  sessionsById.set(map)
  const pend = { ...pendingBySession.get() }
  delete pend[liveId]
  pendingBySession.set(pend)
  delete storedIdMap[liveId]
  if (stored && !isPseudoStoredId(stored)) {
    // Cancel the debounced transcript write before dropping the keys (its
    // fire-time re-read would no-op anyway once the entry is gone, but don't
    // leave it armed).
    const t = persistTimers.get(stored)
    if (t) {
      clearTimeout(t)
      persistTimers.delete(stored)
    }
    clearAttention(stored)
    clearDraft(stored)
    // BUG-033: the queued sends' attachments ride a memory map keyed by
    // queued id — drop them with the queue or they leak for the process
    // lifetime.
    for (const q of sendQueue.get()[stored] ?? []) queuedAttachments.delete(q.id)
    clearSendQueue(stored)
    setSessionLoading(stored, false)
    // Must drop the STORED-keyed v2 entry (and the legacy v1s) or a deleted
    // chat keeps its transcript in AsyncStorage forever. Runs before the map
    // scrub below — the sweep inside uses the live→stored pairs to find
    // legacy keys.
    await dropCachedTranscript(stored)
    // Rotation typically left several live ids mapped here; scrub them all.
    for (const [live, st] of Object.entries(storedIdMap)) {
      if (st === stored) delete storedIdMap[live]
    }
  } else {
    await dropCachedTranscript(stored ?? liveId)
  }
  try {
    await AsyncStorage.setItem(STORED_ID_MAP_KEY, JSON.stringify(storedIdMap))
  } catch {
    /* best effort */
  }
  if (activeSession.get() === liveId) activeSession.set(null)
}

/**
 * Wipe every session-scoped cache this module owns — the backend-switch
 * companion of forgetSession (backendIdentity.ts drives it): stored ids are
 * only meaningful to the backend that minted them, so transcripts, the
 * stored-id map and the last-session pointer from another machine must never
 * hydrate here. In-memory stores reset BEFORE the storage purge, or armed
 * persist debounces would re-write the old blobs from memory (the
 * forgetSession ordering). SAFE to drop wholesale: server history re-hydrates
 * on resume (applyHistory replaces messages; the cache only survives a lazy
 * session) — the device-local tool log is the only real loss.
 */
export async function resetSessionCaches(): Promise<void> {
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  // Resumes keyed by old stored ids must not land their merge after the wipe.
  inflightResumes.clear()
  sessionsById.set({})
  activeSession.set(null)
  sessionLoadings.set({})
  pendingBySession.set({})
  storedIdMap = {}
  // BUG-033: UI residue the old reset skipped — a stale "Couldn't open this
  // chat" banner (its retry closure targets the PREVIOUS machine's stored
  // id), buffered stream deltas, queued-send attachments, and the mascot
  // moment all survived a backend switch.
  chatBanner.set(null)
  mochiMoment.set(null)
  streamBufs.clear()
  queuedAttachments.clear()
  // storedIdMapLoaded stays true: the map is genuinely empty now, and
  // rememberStoredId repopulates it on the next create/resume/info event.
  try {
    // Prefix sweep catches every vintage: stored-keyed `.v2`, the interim
    // stored-keyed `.v1`, and legacy live-keyed `.v1` blobs.
    const keys = await AsyncStorage.getAllKeys()
    const stale = keys.filter((k) => k.startsWith('hermes.transcript.'))
    await AsyncStorage.multiRemove([...stale, LAST_SESSION_KEY, STORED_ID_MAP_KEY])
  } catch {
    /* best effort */
  }
}

/** Append a message the app produced itself (e.g. slash command output).
 *  `cmd` labels a command-output card; it rides the message object (and the
 *  persistence envelope, which stores whole messages) write-once. */
export function pushLocalMessage(text: string, role: 'user' | 'assistant' = 'assistant', cmd?: CommandMeta, targetSid?: string) {
  const t = text.trim()
  if (!t) return
  // BUG-015: an explicit target wins — the active chat may have changed
  // while the command's RPC was in flight, and the output card belongs to
  // the chat the command ran against.
  const sid = targetSid ?? activeSession.get()
  if (!sid) return
  const s = sessionsById.get()[sid]
  if (!s) return
  patchSession(sid, { messages: [...s.messages, { id: nid(), role, text: t.slice(0, 32000), ts: Date.now(), ...(cmd ? { cmd } : {}) }] })
  schedulePersist(sid)
}

export function historyFor(sessionId: string) {
  return sessionsById.get()[sessionId]
}

export function applyHistory(sessionId: string, list?: Array<Record<string, unknown>>) {
  const mapped: ChatMessage[] = []
  for (const m of list ?? []) {
    const role = String(m.role ?? '') === 'user' ? 'user' : 'assistant'
    const raw = (m.content ?? m.text ?? '') as unknown
    const text = textOf(raw).trim()
    if (text === '[object Object]') continue
    // Media-bearing history rows (@image:/@file: directives, markdown
    // images, the gateway's inline native-vision data URLs) surface as media
    // segments on both roles. The 8000-char cap is applied AFTER extraction:
    // a data URL sliced mid-base64 would still match the scanner and become
    // a corrupt, unrenderable segment. A row with nothing visible after
    // extraction drops, exactly like the old empty-text drop.
    const extracted = extractMedia(text ? [{ kind: 'text' as const, text }] : [])
    const hasMedia = extracted.some((seg) => seg.kind === 'media')
    // BUG-083: the gateway forwards each assistant row's durable reasoning
    // on every resume (session_history.py forwards `reasoning` /
    // `reasoning_content` verbatim) — map it into the same collapsible
    // thinking block the live stream renders instead of discarding it.
    // meta stays unset → the header reads a plain "Thought" (the true
    // duration isn't recoverable from history). A reasoning-only row
    // (interrupted turn) is still worth showing; only a row with nothing
    // visible at all drops, exactly like the old empty-text drop.
    const reasoning = role === 'assistant' ? textOf(m.reasoning ?? m.reasoning_content ?? '').trim() : ''
    if (!hasMedia && !text && !reasoning) continue
    // BUG-077: mark truncation instead of silently clipping long rows.
    const capped = extracted.map((seg) =>
      seg.kind === 'text' && seg.text.length > 8000 ? { ...seg, text: `${seg.text.slice(0, 8000)}…` } : seg,
    )
    const segs: ChatSegment[] = []
    if (reasoning) {
      segs.push({
        kind: 'thinking',
        text: `${reasoning.slice(0, 8000)}${reasoning.length > 8000 ? '…' : ''}`,
        startedAt: Number(m.ts ?? m.timestamp ?? Date.now()) || undefined,
      })
    }
    if (hasMedia) {
      segs.push(...capped)
    } else if (reasoning) {
      // REVIEW FIX (BUG-083 follow-up): Chat.tsx's `segmentsOf` renders
      // `segments` INSTEAD of `m.text` — a reasoning row carrying only a
      // thinking segment rendered just the collapsible and dropped the
      // answer outright. The live stream always pushes a text segment
      // alongside thinking for the same reason (see the queueStream append);
      // the history mapping must honor the same contract.
      segs.push({ kind: 'text', text: `${text.slice(0, 8000)}${text.length > 8000 ? '…' : ''}` })
    }
    const rowText = (hasMedia ? joinedTextOf(capped) : text)
    mapped.push({
      id: nid(),
      role,
      text: `${rowText.slice(0, 8000)}${rowText.length > 8000 ? '…' : ''}`,
      ts: Number(m.ts ?? m.timestamp ?? Date.now()),
      ...(segs.length ? { segments: segs } : {}),
    })
  }
  // BUG-084: history rows never carry `streaming` — a resume/reconnect
  // resync flattened an in-flight tail (cursor and live thinking vanished,
  // text went static) and when the server hadn't flushed the partial yet,
  // the mapped replacement DROPPED the live partial answer outright.
  // Re-attach the live tail when it is still the growing end of the
  // conversation: a history row it extends (either direction) resumes as
  // the streaming bubble; otherwise the live partial is appended.
  const prevEntry = sessionsById.get()[sessionId]
  const tail = prevEntry?.messages[prevEntry.messages.length - 1]
  if (tail?.role === 'assistant' && tail.streaming) {
    const last = mapped[mapped.length - 1]
    const cont =
      !!last && last.role === 'assistant' && last.text.length > 0 &&
      (tail.text.startsWith(last.text) || last.text.startsWith(tail.text))
    if (last && cont) {
      mapped[mapped.length - 1] = { ...last, streaming: true, segments: last.segments?.length ? last.segments : tail.segments }
    } else {
      mapped.push(tail)
    }
  }
  if (mapped.length) {
    patchSession(sessionId, { messages: mapped.slice(-MAX_MESSAGES) })
    schedulePersist(sessionId)
  }
}

// ── Sending ────────────────────────────────────────────────────────────────

// One in-flight submit per chat: a send to chat B while chat A's ack is still
// pending must not be queued behind (or delivered to) A.
const sendingSessions = new Set<string>()
// The first-send push arm runs at most once per app run (push.ts's own
// armed-key makes it once per install).
let pushArmed = false

// Hermes answers session-scoped RPCs with this when the live handle died
// server-side (serve restart / reinstall mints fresh live ids) or the stored
// session no longer exists (backend purge, re-pair to a different machine).
const SESSION_NOT_FOUND_RE = /session not found/i
export const isSessionNotFound = (err: unknown): boolean =>
  err instanceof Error && SESSION_NOT_FOUND_RE.test(err.message)

export async function sendPrompt(
  rawText: string,
  opts?: {
    session?: string
    attachments?: PendingAttachment[]
    /** Chip progress sink (composer); absent on queue-flush sends. */
    onAttachment?: (id: string, patch: Partial<PendingAttachment>) => void
  },
) {
  const raw = rawText.trim()
  const attachments = opts?.attachments ?? []
  // Text-optional: attachment-only sends (ChatGPT captionless photos) are the
  // point — early-return only when there is genuinely nothing to send.
  if (!raw && !attachments.length) return
  // The user's own 8000-char slice runs BEFORE ref_text is appended (the
  // refs are budgeted on top, never truncated) — see appendRefText.
  const text = raw.slice(0, 8000)
  flushStreams()
  // A pinned send targets one specific session (the busy-queue flush uses
  // this when its chat's turn ends while the user is elsewhere). Unpinned
  // sends keep the old contract: whatever chat is active.
  const pinned = opts?.session
  // A pinned send to a session that vanished (deleted mid-flight) must fail,
  // never fall through to the active chat.
  if (pinned && !sessionsById.get()[pinned]) {
    throw new Error(`sendPrompt: pinned session ${pinned} is not tracked`)
  }
  const lockKey = pinned ?? activeSession.get() ?? '_boot'
  if (sendingSessions.has(lockKey)) {
    // BUG-003: the composer is already cleared and no bubble exists — the
    // old silent outbox park made the text invisible (the outbox only
    // flushes on an offline→online edge) and a later flush would deliver
    // it to whichever chat is active. Park it on the chat's VISIBLE
    // busy-queue instead: the strip shows it immediately and
    // maybeFlushQueue delivers it when this chat's turn ends.
    const lockedStored = sessionsById.get()[lockKey]?.storedId
    if (lockedStored) {
      const queuedItem = enqueueSend(lockedStored, text, { allowEmpty: attachments.length > 0 })
      if (queuedItem) {
        if (attachments.length) setQueuedAttachments(queuedItem.id, attachments)
        return
      }
      // Queue full — fall through to the outbox so the text still survives.
    }
    enqueueOffline(text, lockedStored ?? '')
    return
  }
  sendingSessions.add(lockKey)
  // First message of a fresh install is the one honest moment to offer push
  // ("buzz me when the reply lands") — one ask per install, fire-and-forget,
  // and never on a cold app open. Lazy require: chat.ts must stay loadable in
  // plain node (suites) and push.ts drags expo modules.
  if (!pushArmed) {
    pushArmed = true
    try { void require('./push').armPushOnFirstSend() } catch {}
  }

  let sid = ''
  let rowId = ''
  try {
    try {
      const ps = pinned ? sessionsById.get()[pinned] : undefined
      if (ps?.provisional) {
        // The optimistic new-chat window — wait for ITS create (the entry is
        // active by construction), never a second one.
        sid = await ensureSession()
      } else if (ps && !ps.detached) {
        sid = pinned!
      } else if (ps?.storedId) {
        // The handle was released (idle evict) — bring it back quietly (this
        // may be a background flush; the shared core's re-point is guarded,
        // so it can't steal the screen), then send.
        sid = (await resumeShared(ps.storedId)).sessionId
      } else {
        sid = await ensureSession()
      }
    } catch (err) {
      // Offline — keep the message visible as failed with retry. Patch the
      // session we tried to reach (the active one unless this was pinned).
      // The row keeps its media segments (rendered from localUri) so the
      // user sees what failed; the attachments themselves are not retried
      // (known silent-loss path: nothing was uploaded yet, the outbox stays
      // text-only — see the design's finding 9).
      const target = pinned ?? activeSession.get()
      const t0 = target ? sessionsById.get()[target] : undefined
      if (t0) {
        patchSession(target!, {
          messages: [
            ...t0.messages,
            {
              id: nid(),
              role: 'user',
              text,
              ts: Date.now(),
              status: 'failed',
              error: err instanceof Error ? err.message : 'Not connected',
              ...(attachments.length ? { segments: userSegmentsFor(text, attachments) } : {}),
            },
          ],
        })
        mochiMoment.set({ kind: 'error', sid: target!, at: Date.now() })
      }
      // BUG-008: re-enqueue pinned to the chat the send was bound for, so a
      // later flush delivers it HERE and not to whichever chat is active.
      enqueueOffline(text, t0?.storedId ?? '')
      throw err
    }

    // Patch THIS session: a fast chat switch mid-send must not graft the user
    // bubble onto whichever conversation is active by the time this runs.
    rowId = nid()
    const s = sessionsById.get()[sid]
    if (s) {
      patchSession(sid, {
        messages: [
          ...s.messages,
          {
            id: rowId,
            role: 'user',
            text,
            ts: Date.now(),
            ...(attachments.length ? { segments: userSegmentsFor(text, attachments) } : {}),
          },
        ],
        tools: [],
        busy: true,
      })
    }
    // The single funnel for the mascot's task-received / thank-you / shy
    // reactions: direct sends and queued heads (maybeFlushQueue) both pass.
    mochiSent.set({ text, sid, at: Date.now() })
    // The user is here and acting — drop any stale badge on this chat.
    clearAttentionLive(sid)
    schedulePersist(sid)

    // ── Attach step (mirrors desktop withSessionNotFoundResume): upload +
    // image.attach/file.attach AFTER the live sid resolves, immediately
    // before prompt.submit. processAttachments detaches on its own internal
    // failures; a prompt.submit failure below detaches explicitly so the
    // session never carries orphaned images into the next turn.
    let submitText = text
    let attachedImagePaths: string[] = []
    if (attachments.length) {
      const outcome = await processAttachments({
        sessionId: sid,
        attachments,
        onAttachment: opts?.onAttachment,
      })
      attachedImagePaths = outcome.attachedImagePaths
      submitText = appendRefText(text, outcome.refTexts)
      patchRowMediaPaths(sid, rowId, attachments, outcome.pathsById)
    }
    try {
      try {
        await rpc('prompt.submit', { session_id: sid, text: submitText })
      } catch (err) {
        if (!isSessionNotFound(err)) throw err
        // The live handle died server-side (serve restart / reinstall) while
        // the chat looked perfectly open. Re-resume by the stored id — that
        // mints a fresh live id, and runResume's merge carries the user row
        // we already appended onto the new entry — then retry once. Desktop
        // parity: withSessionNotFoundResume.
        const stored = sessionsById.get()[sid]?.storedId
        if (!stored) throw err
        log('warn', 'chat', `session not found (${sid}) — re-resuming ${stored} and retrying the send`)
        const fresh = await resumeShared(stored)
        sid = fresh.sessionId
        await rpc('prompt.submit', { session_id: sid, text: submitText })
      }
    } catch (err) {
      if (attachedImagePaths.length) void detachImages(sid, attachedImagePaths)
      throw err
    }
    // Revive-to-top: the send just made this chat the most recently active
    // one — bump its local timestamp and move its list row to the front so
    // the drawer/Chats reorders NOW (the ≤60s poll would otherwise be the
    // first reorder, and the row's started_at is creation time only).
    const sentStored = sessionsById.get()[sid]?.storedId
    if (sentStored) bumpSessionActivity(sentStored)
  } catch (err) {
    if (sid) {
      const s2 = sessionsById.get()[sid]
      if (s2) patchSession(sid, { busy: false })
      const list = [...(s2?.messages ?? [])]
      const idx = rowId
        ? list.findIndex((m) => m.id === rowId)
        : [...list].reverse().findIndex((m) => m.role === 'user' && m.text === text)
      if (idx >= 0) {
        const real = rowId ? idx : list.length - 1 - idx
        list[real] = { ...list[real], status: 'failed', error: err instanceof Error ? err.message : 'Send failed' }
        patchSession(sid, { messages: list })
      }
    } else {
      patchActive({ busy: false })
    }
    throw err
  } finally {
    sendingSessions.delete(lockKey)
  }
}

export async function retryMessage(id: string) {
  const sid = activeSession.get()
  if (!sid) return
  const m = sessionsById.get()[sid]?.messages.find((x) => x.id === id)
  if (!m || m.role !== 'user') return
  // Media rows are not retryable (design finding 9): the attachments can't be
  // re-picked from here, so a text-only retry would silently drop them.
  if (m.segments?.some((seg) => seg.kind === 'media')) return
  patchSession(sid, { messages: messages.get().filter((x) => x.id !== id) })
  // BUG-008: drop this chat's outbox copy of the same text first — the old
  // code resent while the outbox entry survived, so the reconnect flush
  // delivered the message a second time. If the retry fails, sendPrompt's
  // offline path re-enqueues it, so exactly one copy always remains.
  const retryStored = sessionsById.get()[sid]?.storedId ?? ''
  outbox.set(outbox.get().filter((x) => !(x.text === m.text && (x.storedId === retryStored || x.storedId === ''))))
  void persistOutbox()
  // Pinned to THIS chat: a retry must never land in whichever chat is
  // active by the time the RPC resolves.
  await sendPrompt(m.text, { session: sid })
}

export async function stopRun() {
  const sid = activeSession.get()
  if (!sid) return
  let stopped = false
  try {
    await rpc('session.interrupt', { session_id: sid })
    stopped = true
  } catch (err) {
    log('warn', 'chat', `interrupt failed: ${String(err)}`)
  }
  flushStreams()
  // BUG-047: only declare idle when the interrupt actually landed — the old
  // code cleared busy unconditionally, so a failed interrupt showed idle
  // while the server kept generating and the queue head flushed into a
  // still-running turn. Turn-end events reconcile the UI either way.
  if (stopped) patchSession(sid, { busy: false })
  mochiMoment.set({ kind: 'apologetic', sid, at: Date.now() })
  if (stopped) {
    // A stop is a turn-end edge too — queued follow-ups get their turn.
    maybeFlushQueue(sid)
  }
}

export async function steerRun(text: string) {
  const sid = activeSession.get()
  const t = text.trim().slice(0, 4000)
  if (!sid || !t) return
  const userRow = { id: nid(), role: 'user' as const, text: t, ts: Date.now() }
  // BUG-015: the user row belongs to `sid` — read THAT session's messages
  // from the map at patch time, never the computed ACTIVE view. The old
  // `messages.get()` resolved to whichever chat was active after the RPC:
  // switching mid-steer grafted — or wholesale replaced — the WRONG chat's
  // transcript while the steer bubble appeared nowhere.
  const targetMessages = () => sessionsById.get()[sid]?.messages ?? []
  // Prefer a true interrupt: `session.redirect` cancels the in-flight model
  // request (completed work + partial reasoning stay as context), appends the
  // text as a real user message, and the agent loop retries NOW — so a steer
  // sent during a no-tool reply lands immediately instead of riding the next
  // turn. While tools execute the server degrades it to a boundary steer on
  // its own, and a turn still building comes back 'queued' (next turn).
  try {
    const r = await rpc<{ status?: string }>('session.redirect', { session_id: sid, text: t })
    if (r?.status === 'redirected' || r?.status === 'queued') {
      patchSession(sid, { messages: [...targetMessages(), userRow] })
      return
    }
  } catch {
    /* unsupported agent or an idle race — plain steer still applies it */
  }
  // Fallback: buffer for the next tool-batch boundary. Works WHILE busy —
  // separate path from sendPrompt.
  await rpc('session.steer', { session_id: sid, text: t })
  patchSession(sid, { messages: [...targetMessages(), userRow] })
}

// ── Busy-queue flush ───────────────────────────────────────────────────────
//
// Messages sent while a turn was running sit in the per-chat queue (see
// sendQueue.ts). Every "session went idle" edge below hands the queue head to
// sendPrompt; the turn it starts keeps the session busy, and that turn's own
// end edge releases the next one — one queued message per turn, in order.

const queueFlushes = new Set<string>()

function maybeFlushQueue(liveId: string): void {
  const s = sessionsById.get()[liveId]
  if (!s?.storedId || s.busy || s.detached) return
  if (pendingBySession.get()[liveId]?.length) return // a question still blocks it
  if (!isConnected.get()) return // the reconnect edge retries
  if (sendingSessions.has(liveId)) return // a manual send is mid-ack
  if (queueFlushes.has(liveId)) return
  const head = peekQueued(s.storedId)
  if (!head) return
  queueFlushes.add(liveId)
  void (async () => {
    try {
      // Attachments composed with the head ride the in-memory map; nothing
      // was uploaded yet, so the attach step runs inside this sendPrompt.
      await sendPrompt(head.text, { session: liveId, attachments: queuedAttachments.get(head.id) })
      removeQueued(s.storedId, head.id)
      queuedAttachments.delete(head.id)
      // No recursion here: the submit only ACKed — busy is already true, and
      // the new turn's end edge (or its failure) drives the next release.
    } catch (err) {
      // BUG-073: a session deleted mid-flush throws "not tracked" here —
      // say so instead of a silent empty catch (acceptable for a deleted
      // chat, but it should be visible in the log).
      log('warn', 'chat', `queued head flush failed for ${liveId}: ${String(err)}`)
    } finally {
      queueFlushes.delete(liveId)
    }
  })()
}

// ── Server request answers (v7) ────────────────────────────────────────────
//
// The backend asks us questions over the same socket. Answering is a JSON-RPC
// RESPONSE frame carrying the request's `srq-…` id — there is no
// `*.respond` RPC method. (`clarify.respond`, `sudo.respond` and
// `secret.respond` do not exist and answer -32601.)

function withPending(sessionId: string, fn: (list: PendingRequest[]) => PendingRequest[]) {
  const map = { ...pendingBySession.get() }
  map[sessionId] = fn(map[sessionId] ?? [])
  pendingBySession.set(map)
  refreshBadge()
}

function answer(id: string, result: Record<string, unknown>) {
  getClient()?.respondServerRequest(id, result)
}

/** Retire an answered/cancelled question from the queue for its session. */
function retire(req: PendingRequest) {
  withPending(req.sessionId, (list) => list.filter((r) => r.id !== req.id))
  refreshBadge()
  // The last question resolved → the turn resumes (or ends); the yellow
  // "waiting on you" marker has done its job. While questions remain queued
  // the session is still blocked, so keep it.
  if (!(pendingBySession.get()[req.sessionId]?.length)) {
    clearAttentionLive(req.sessionId)
    // The answer may have been what let the turn finish — release the queue.
    maybeFlushQueue(req.sessionId)
  }
}

export async function respondApproval(choice: 'once' | 'session' | 'always' | 'deny', all = false) {
  const req = pendingRequest.get()
  if (!req || req.method !== 'approval') return
  // v7 answer shape: { choice, all? }
  answer(req.id, { choice, all: all || undefined })
  retire(req)
  log('info', 'chat', `approval answered: ${choice}`)
}

export async function respondClarify(answerText: string) {
  const t = answerText.trim().slice(0, 4000)
  if (!t) return
  const req = pendingRequest.get()
  if (!req || req.method !== 'clarify') return
  // v7 answer shape: { answer } — or { answers } for a batch.
  answer(req.id, { answer: t })
  retire(req)
  log('info', 'chat', `clarify answered: ${req.id}`)
}

/** Answer a batch clarify with one answer per question id. */
export async function respondClarifyBatch(answers: Record<string, string>) {
  const req = pendingRequest.get()
  if (!req || req.method !== 'clarify') return
  answer(req.id, { answers })
  retire(req)
  log('info', 'chat', `clarify batch answered: ${req.id}`)
}

export async function respondPrivileged(allow: boolean, value?: string) {
  const req = pendingRequest.get()
  if (!req || (req.method !== 'sudo' && req.method !== 'secret')) return
  // v7 answer shape: { value }. A deny is an empty value — the backend treats
  // a blank secret as "not provided".
  answer(req.id, allow ? { value: value ?? '' } : {})
  retire(req)
  log('info', 'chat', `${req.method} ${allow ? 'allowed' : 'denied'}`)
}

// ── Server request intake ──────────────────────────────────────────────────

function onServerRequestMessage(req: {
  id: string
  method: string
  params: Record<string, unknown>
  replayed?: boolean
}): boolean {
  const p = req.params ?? {}
  let sessionId = typeof p.session_id === 'string' ? p.session_id : (activeSession.get() ?? '')
  // BUG-089: resolve the id through the tracked map before filing —
  // (a) a request emitted under an OLD live id during resume rotation lands
  // under a dead key (unmarked AND unanswerable); rebind it to the current
  // live id for the same stored id.
  if (sessionId && !sessionsById.get()[sessionId]) {
    const stored = storedIdFor(sessionId)
    const rebound = stored ? Object.values(sessionsById.get()).find((s) => s.storedId === stored)?.id : undefined
    if (rebound) sessionId = rebound
  }
  // BUG-067: a ''-keyed request can never match any activeSession, so the
  // question would sit unfiled AND unanswerable until the backend's deadline.
  // There is nothing sensible to do with an unaddressable request — log and
  // drop it (the backend's own deadline handles its side).
  if (!sessionId) {
    log('warn', 'chat', `server request ${req.method} has no session_id and no active chat — dropped`)
    return false
  }

  switch (req.method) {
    case 'approval': {
      const item: PendingRequest = {
        id: req.id,
        method: 'approval',
        sessionId,
        command: typeof p.command === 'string' ? p.command.slice(0, 800) : undefined,
        description: typeof p.description === 'string' ? p.description.slice(0, 800) : undefined,
        choices: Array.isArray(p.choices) ? p.choices.map(String) : undefined,
        allowPermanent: p.allow_permanent === true,
        allowSession: p.allow_session === true,
        smartDenied: p.smart_denied === true,
        toolName: typeof p.tool_name === 'string' ? p.tool_name : undefined,
        replayed: req.replayed,
      }
      withPending(sessionId, (list) => [...list, item])
      flagAttention(
        sessionId,
        'input',
        { title: 'Approval needed', body: item.command ?? item.description ?? 'The agent wants to run a command.' },
        // Replayed questions (reconnect/resume) re-mark the row but don't
        // re-notify — the user already heard about this one.
        { suppress: item.replayed },
      )
      return true
    }

    case 'clarify': {
      const item: PendingRequest = {
        id: req.id,
        method: 'clarify',
        sessionId,
        question: typeof p.question === 'string' ? p.question.slice(0, 1000) : undefined,
        options: Array.isArray(p.choices) ? p.choices.map(String).slice(0, 12) : undefined,
        questions: Array.isArray(p.questions)
          ? (p.questions as Array<Record<string, unknown>>).map((q) => ({
              qid: String(q.qid ?? ''),
              question: typeof q.question === 'string' ? q.question.slice(0, 1000) : undefined,
              choices: Array.isArray(q.choices) ? q.choices.map(String).slice(0, 12) : undefined,
              multi_select: q.multi_select === true,
            }))
          : undefined,
        replayed: req.replayed,
      }
      withPending(sessionId, (list) => [...list, item])
      flagAttention(
        sessionId,
        'input',
        { title: 'Agent asks', body: item.question ?? 'Clarification needed' },
        { suppress: item.replayed },
      )
      return true
    }

    case 'sudo':
    case 'secret': {
      const item: PendingRequest = {
        id: req.id,
        method: req.method,
        sessionId,
        command: typeof p.command === 'string' ? p.command.slice(0, 800) : undefined,
        prompt:
          req.method === 'secret'
            ? (typeof p.prompt === 'string' ? p.prompt.slice(0, 500) : `Enter ${String(p.env_var ?? 'secret')}`)
            : (typeof p.command === 'string' ? p.command.slice(0, 500) : 'Elevated access requested'),
        envVar: typeof p.env_var === 'string' ? p.env_var : undefined,
        replayed: req.replayed,
      }
      withPending(sessionId, (list) => [...list, item])
      flagAttention(
        sessionId,
        'input',
        { title: req.method === 'sudo' ? 'Sudo requested' : 'Secret requested', body: item.prompt ?? '' },
        { suppress: item.replayed },
      )
      return true
    }

    // Surfaces the phone has no UI for. Declining (return false) makes the
    // channel answer -32601 so the backend stops waiting instead of burning
    // the full deadline.
    default:
      log('warn', 'chat', `no handler for server request: ${req.method} (${req.id})`)
      return false
  }
}

// ── Event intake ───────────────────────────────────────────────────────────

function upsertToolIn(sessionId: string, t: ToolItem) {
  const s = sessionsById.get()[sessionId]
  if (!s) return
  const list = [...s.tools]
  const i = list.findIndex((x) => x.id === t.id)
  if (i >= 0) list[i] = { ...list[i], ...t }
  else list.push(t)
  patchSession(sessionId, { tools: list.slice(-MAX_TOOLS) })
}

/** True when the chat tab is showing this session's events right now. */
function isShowing(sessionId?: string): boolean {
  if (!sessionId) return false
  return sessionId === activeSession.get() && chatTabFocused.get()
}

/** True when the user can't see the chat (background/inactive). */
function isBackgrounded(): boolean {
  try {
    return AppState.currentState !== 'active'
  } catch {
    return false
  }
}

function clearAttentionLive(liveId: string) {
  const stored = sessionsById.get()[liveId]?.storedId
  if (stored) clearAttention(stored)
}

/**
 * Record an attention state for a session and surface it where the user will
 * see it: an in-app toast when the app is foregrounded, a local push
 * notification when it isn't. Both deep-link to the chat. No-ops when the
 * user is already watching that chat (they saw it happen live), except that
 * `input`/`error` still mark the row — leaving without answering should show
 * yellow, an error they watched stays red until reopened.
 */
function flagAttention(
  liveId: string,
  kind: AttentionKind,
  notify: { title: string; body: string },
  opts?: { suppress?: boolean },
) {
  const s = sessionsById.get()[liveId]
  if (!s?.storedId) return
  // "Showing" must mean the user can actually see it: the chat route stays
  // focused while the app is backgrounded, so route-focus alone suppressed
  // every completion notification (the turn-done knock never fired from the
  // app's own UI).
  const watching = isShowing(liveId) && !isBackgrounded()
  if (kind === 'done' && watching) {
    // The user watched the turn land — nothing to draw attention to.
    clearAttention(s.storedId)
  } else {
    markAttention(s.storedId, kind)
  }
  if (opts?.suppress || watching) return
  const body = notify.body.replace(/\s+/g, ' ').trim().slice(0, 180)
  if (isBackgrounded()) {
    void notifyLocal(notify.title, body, { screen: 'chat', storedId: s.storedId, kind })
  } else {
    pushToast({ kind, title: notify.title, body, storedId: s.storedId, chatTitle: s.title })
  }
}

function refreshBadge() {
  void setBadge(pendingCount.get())
}

let chatHooked = false

export function hookChatEvents() {
  if (chatHooked) return
  chatHooked = true

  // Live model/provider tracking (session.info events).
  hookModelState()

  // Server->client requests. Handled separately from events.
  onServerRequest(onServerRequestMessage)

  // Reconnect: every idle session with queued messages gets another chance,
  // and the session ON SCREEN re-syncs. Why the resync: a background freeze
  // kills the socket mid-turn; the turn usually FINISHES server-side while
  // the process is frozen, and those final events never arrive — the screen
  // sits busy and silent until the user switches chats and back (which heals
  // purely because switching resumes). Do that resume here instead: the
  // shared dedupe collapses overlaps and runResume's re-point is guarded, so
  // for an already-healthy screen this is one cheap RPC that changes nothing.
  // (Still-running turns keep their old live id; this covers the dominant
  // finished-while-frozen case — the same one switching healed.)
  isConnected.subscribe((online) => {
    if (!online) return
    for (const id of Object.keys(sessionsById.get())) maybeFlushQueue(id)
    const live = activeSession.get()
    const stored = live ? sessionsById.get()[live]?.storedId : undefined
    if (stored && !isPseudoStoredId(stored)) {
      void resumeShared(stored).catch((e) => log('warn', 'chat', `reconnect resync failed: ${String(e)}`))
    }
  })

  onEvent((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>

    const eSid = e.session_id
    if (!eSid) return
    const s = sessionsById.get()[eSid]
    if (!s) return // event for a session we're not tracking

    switch (e.type) {
      case 'session.info': {
        // SessionLiveInfo carries `title`; prefer the payload's own session_id
        // when present, otherwise the event's.
        const sid = typeof p.session_id === 'string' && sessionsById.get()[p.session_id] ? p.session_id : eSid
        const title = typeof p.title === 'string' && p.title ? p.title : undefined
        if (title) {
          patchSession(sid, { title })
          patchRowTitle([typeof p.stored_session_id === 'string' ? p.stored_session_id : undefined, storedIdFor(eSid)], title)
        }
        if (typeof p.stored_session_id === 'string' && p.stored_session_id) {
          void rememberStoredId(sid, p.stored_session_id)
        }
        noteSessionInfo({
          model: typeof p.model === 'string' ? p.model : undefined,
          provider: typeof p.provider === 'string' ? p.provider : undefined,
          reasoning_effort: typeof p.reasoning_effort === 'string' ? p.reasoning_effort : undefined,
        })
        break
      }

      case 'session.title': {
        const title = typeof p.title === 'string' ? p.title : undefined
        if (title) {
          patchSession(eSid, { title })
          // The payload's session_id is the STORED key; the row list is keyed
          // by stored ids, so the drawer renames mid-turn too.
          patchRowTitle([storedIdFor(eSid), typeof p.session_id === 'string' ? p.session_id : undefined], title)
        }
        break
      }

      case 'session.reclaimed': {
        // The backend evicted the live session (idle timeout / LRU evict). The
        // transcript is still valid, but the live handle is dead — mark it so
        // the next send transparently resumes instead of failing.
        flushStreams()
        log('warn', 'chat', `session reclaimed: ${String(p.reason)}`)
        patchSession(eSid, { busy: false, detached: true })
        if (isShowing(eSid)) {
          void notifyLocal(
            'Session released',
            `Hermes closed this session (${String(p.reason ?? 'idle')}). It will reconnect when you send.`,
            { screen: 'chat' },
          )
        } else {
          // BUG-088: a mid-turn release ends the turn SILENTLY when the user
          // is elsewhere — no pulse, no dot, nothing. Mark the row so the
          // chat isn't a dead end.
          flagAttention(eSid, 'done', {
            title: 'Session released',
            body: `Hermes closed this session (${String(p.reason ?? 'idle')}). Send a message to reconnect.`,
          })
        }
        break
      }

      case 'session.usage': {
        const usage = p.usage as Record<string, unknown> | undefined
        const text = usage
          ? formatUsage(usage)
          : typeof p.text === 'string'
            ? p.text
            : ''
        if (text) patchSession(eSid, { usage: text })
        break
      }

      case 'todo.updated': {
        const items = (p.todos ?? p.items) as unknown
        if (Array.isArray(items)) {
          patchSession(eSid, {
            todos: items
              .slice(0, 30)
              .map((t) => {
                const o = (t ?? {}) as Record<string, unknown>
                return {
                  text: String(o.text ?? o.title ?? t ?? '').slice(0, 200),
                  done: !!(o.done ?? o.completed ?? o.status === 'done'),
                }
              })
              .filter((t) => t.text),
          })
        }
        break
      }

      case 'message.start': {
        flushStreams()
        // Revive-to-top: a turn starting is activity — bump the chat so the
        // drawer bubbles it (order only; content stays server-authoritative).
        const startStored = sessionsById.get()[eSid]?.storedId
        if (startStored) bumpSessionActivity(startStored)
        // A new turn is in flight — any prior attention marker (green "done",
        // red "error") is stale; the busy pulse takes over until it lands.
        clearAttentionLive(eSid)
        // Re-read: flushStreams just replaced the messages array; the `s`
        // captured at handler top is stale by one flush.
        const cur = sessionsById.get()[eSid]
        if (!cur) break
        const list = cur.messages
        const last = list[list.length - 1]
        if (last?.role === 'assistant' && last.streaming) {
          // BUG-060: a STALE streaming tail (its turn died without a terminal
          // event — killed process, lost frame) would swallow this new row:
          // flushStreams grafts the new turn onto the old bubble. Finalize
          // the stale tail first so each turn renders as its own message.
          const list2 = [...cur.messages]
          list2[list2.length - 1] = freezeThoughts({ ...last, streaming: false })
          patchSession(eSid, { messages: list2 })
        }
        const cur2 = sessionsById.get()[eSid]
        const list2 = cur2?.messages ?? []
        patchSession(eSid, {
          messages: [...list2, { id: nid(), role: 'assistant', text: '', streaming: true, ts: Date.now() }],
        })
        break
      }

      case 'message.delta': {
        const text = String(p.text ?? p.delta ?? '')
        if (text) queueStream(eSid, 'text', text)
        break
      }

      case 'message.interim':
        break

      case 'message.complete': {
        flushStreams()
        // Revive-to-top: same bump as message.start — covers turns whose
        // start event was missed (reconnect/replay gap).
        const doneStored = sessionsById.get()[eSid]?.storedId
        if (doneStored) bumpSessionActivity(doneStored)
        const text = typeof p.text === 'string' ? p.text : ''
        const cur = sessionsById.get()[eSid]
        if (!cur) break
        const list = [...cur.messages]
        let finalJoined = ''
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role !== 'assistant' || !list[i].streaming) continue
          const failed = p.status === 'error' || !!p.error
          let done: ChatMessage = {
            ...list[i],
            streaming: false,
            status: failed ? 'failed' : 'ok',
            error: failed ? String(p.error ?? p.failure_reason ?? 'Turn failed') : undefined,
          }
          if (text) {
            // Server-sent final text supersedes the streamed segments' text.
            const segs = (done.segments ?? []).map((seg) => ({ ...seg }))
            const lastTextIdx = segs.map((seg) => seg.kind).lastIndexOf('text')
            if (lastTextIdx >= 0) segs[lastTextIdx] = { ...segs[lastTextIdx], text: text.slice(0, 32000) }
            else segs.push({ kind: 'text', text: text.slice(0, 32000) })
            done = { ...done, segments: segs }
          }
          // Media extraction runs AFTER the supersede, in place: @image:/
          // @file: directives and markdown images in the final text become
          // media segments directly after their source segment. Idempotent —
          // markers are stripped, so a later pass (history reload) is a no-op.
          const base: ChatSegment[] = done.segments ?? (done.text ? [{ kind: 'text', text: done.text }] : [])
          const extracted = extractMedia(base)
          finalJoined = joinedTextOf(extracted).slice(0, 32000)
          done = { ...done, segments: extracted, text: finalJoined }
          list[i] = freezeThoughts(done)
          break
        }
        // BUG-061: the finalize loop only updates an EXISTING streaming row —
        // if message.start was missed (a reconnect/replay gap on a remote
        // backend), the server's final answer was discarded while busy flipped
        // false. Append it as a completed message instead.
        if (!finalJoined && text) {
          const failed = p.status === 'error' || !!p.error
          list.push({
            id: nid(),
            role: 'assistant',
            text: stripMediaFromText(text).slice(0, 32000),
            ts: Date.now(),
            ...(failed ? { status: 'failed' as const, error: String(p.error ?? p.failure_reason ?? 'Turn failed') } : {}),
          })
        }
        if (list.length) patchSession(eSid, { messages: list })
        patchSession(eSid, {
          tools: cur.tools.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)),
          busy: false,
        })
        schedulePersist(eSid)
        maybeFlushQueue(eSid)
        const failed = p.status === 'error' || !!p.error
        // Re-derived from the STRIPPED text segments (fallback: raw server
        // text minus markers) so attention bodies never carry @file: noise.
        const finalText = finalJoined || stripMediaFromText(text)
        flagAttention(
          eSid,
          failed ? 'error' : 'done',
          {
            title: failed ? 'Turn failed' : 'Agent replied',
            body: failed ? String(p.error ?? p.failure_reason ?? 'Turn failed') : finalText,
          },
        )
        // Mascot: error on a failed turn; on success the hook promotes to a
        // celebration when its own busy-start says the turn ran ≥30s.
        mochiMoment.set({ kind: failed ? 'error' : 'success', sid: eSid, at: Date.now() })
        break
      }

      case 'thinking.delta':
      case 'reasoning.delta': {
        const text = String(p.text ?? p.delta ?? '')
        if (text) queueStream(eSid, 'thinking', text)
        break
      }

      case 'tool.start': {
        const id = String(p.tool_id ?? p.id ?? '')
        upsertToolIn(eSid, {
          id: id || nid(),
          name: String(p.name ?? 'tool'),
          preview: p.preview ? String(p.preview).slice(0, 200) : undefined,
          status: 'running',
        })
        break
      }

      case 'tool.complete': {
        const id = String(p.tool_id ?? p.id ?? '')
        const failed = p.status === 'failed' || !!p.error
        if (!id) {
          const name = String(p.name ?? '')
          if (name) {
            const list = [...s.tools]
            const i = [...list].reverse().findIndex((t) => t.name === name && t.status === 'running')
            if (i >= 0) {
              const idx = list.length - 1 - i
              list[idx] = { ...list[idx], status: failed ? 'failed' : 'done', durationS: typeof p.duration_s === 'number' ? p.duration_s : list[idx].durationS }
              patchSession(eSid, { tools: list })
            }
          }
          break
        }
        upsertToolIn(eSid, {
          id,
          name: String(p.name ?? s.tools.find((t) => t.id === id)?.name ?? 'tool'),
          preview: p.preview ? String(p.preview).slice(0, 200) : undefined,
          durationS: typeof p.duration_s === 'number' ? p.duration_s : undefined,
          status: failed ? 'failed' : 'done',
        })
        break
      }

      case 'request.cancel': {
        // The backend withdrew a question (timeout / interrupt / session closed).
        // Tear the card down so the composer is not blocked by a dead question.
        const rid = String(p.id ?? '')
        const list = pendingBySession.get()[eSid] ?? []
        if (list.some((r) => r.id === rid)) {
          log('info', 'chat', `question withdrawn (${String(p.reason ?? 'unknown')})`)
          withPending(eSid, (l) => l.filter((r) => r.id !== rid))
          if (!(pendingBySession.get()[eSid]?.length)) {
            clearAttentionLive(eSid)
            maybeFlushQueue(eSid)
          }
        }
        break
      }

      case 'background.complete': {
        flushStreams()
        patchSession(eSid, { busy: false })
        maybeFlushQueue(eSid)
        log('info', 'chat', `background complete: ${JSON.stringify(p).slice(0, 200)}`)
        flagAttention(
          eSid,
          'done',
          { title: 'Background task done', body: String(p.text ?? JSON.stringify(p)) },
        )
        // Mascot celebration branch of the map's success entry (a background
        // win only animates when this chat is the one on screen — the hook's
        // land-time sid gate).
        mochiMoment.set({ kind: 'celebration', sid: eSid, at: Date.now() })
        break
      }

      case 'status.update': {
        if (p.busy === false) {
          flushStreams()
          patchSession(eSid, { busy: false })
          maybeFlushQueue(eSid)
        }
        break
      }

      case 'error': {
        flushStreams()
        const msg = String(p.message ?? p.error ?? 'Gateway error')
        const cur = sessionsById.get()[eSid]
        if (!cur) break
        const list = [...cur.messages]
        const last = list[list.length - 1]
        if (last?.streaming) {
          list[list.length - 1] = freezeThoughts({
            ...last,
            streaming: false,
            // BUG-010: keep any partial text but MARK the failure — the old
            // code silently discarded the error (a half-answered turn looked
            // complete: no failed marker, no error surface) or, on an empty
            // bubble, rendered the raw error string as the agent's answer
            // with copy/Listen buttons attached.
            ...(last.text ? {} : { text: msg }),
            status: 'failed',
            error: msg,
          })
        } else {
          list.push({ id: nid(), role: 'assistant', text: msg, ts: Date.now(), status: 'failed', error: msg })
        }
        patchSession(eSid, { messages: list, busy: false })
        schedulePersist(eSid)
        flagAttention(eSid, 'error', { title: 'Turn failed', body: msg })
        mochiMoment.set({ kind: 'error', sid: eSid, at: Date.now() })
        // A failed turn still ends the turn — queued follow-ups go out.
        maybeFlushQueue(eSid)
        break
      }

      case 'notice': {
        const msg = String(p.message ?? '')
        if (msg && isBackgrounded()) void notifyLocal('Hermes', msg.slice(0, 180), { screen: 'chat' })
        break
      }
    }
  })
}

function formatUsage(u: Record<string, unknown>): string {
  const total = Number(u.total ?? 0)
  const input = Number(u.input ?? 0)
  const output = Number(u.output ?? 0)
  const cost = typeof u.cost === 'number' ? u.cost : undefined
  const parts = [`${total.toLocaleString()} tok`]
  if (input) parts.push(`in ${input.toLocaleString()}`)
  if (output) parts.push(`out ${output.toLocaleString()}`)
  if (cost !== undefined) parts.push(`$${cost.toFixed(3)}`)
  return parts.join(' · ')
}

// ── Server-list reconciliation (BUG-025) ───────────────────────────────────
// Chats deleted elsewhere (another device, a serve reinstall) used to haunt
// the drawer forever: nothing pruned sessionsById against sessionRows, so
// the local entry survived until an app restart — and tapping it always
// failed to the retry banner. When a COMPLETE server list is in hand (a
// truncated one proves nothing about absence), drop tracked sessions whose
// stored id is absent — except the chat on screen and provisional windows.
sessionRows.subscribe((rows) => {
  if (!rows.length || !sessionListComplete.get()) return
  const active = activeSession.get()
  const map = sessionsById.get()
  const present = new Set(rows.map((r) => r.id))
  let changed = false
  let pendChanged = false
  const next = { ...map }
  const pend = { ...pendingBySession.get() }
  for (const [liveId, s] of Object.entries(map)) {
    if (liveId === active || s.provisional || liveId.startsWith('pending:')) continue
    if (present.has(s.storedId)) continue
    delete next[liveId]
    changed = true
    if (pend[liveId]) {
      delete pend[liveId]
      pendChanged = true
    }
    if (s.storedId && !isPseudoStoredId(s.storedId)) {
      clearAttention(s.storedId)
      // BUG-066: the chat is gone server-side — drop its cached transcript
      // too, or the AsyncStorage blob (up to 300 messages) persists forever
      // (the user can no longer trigger forgetSession on a chat that isn't
      // even listed).
      void dropCachedTranscript(s.storedId)
    }
  }
  if (changed) sessionsById.set(next)
  if (pendChanged) pendingBySession.set(pend)
})

export { refreshBadge }
