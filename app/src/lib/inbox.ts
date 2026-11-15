/**
 * The Inbox: one place that answers "what needs me right now?".
 *
 * Three things already exist in the app and each one is *somebody else's*
 * source of truth, so this module only JOINS them — it never fetches, never
 * writes, and never invents a state:
 *
 *   ask    — a server question still awaiting an answer. The live map lives in
 *            lib/chat (pendingBySession, keyed by LIVE session id); the
 *            read-only `pendingByStoredId` selector there re-keys it to the
 *            STORED ids every surface uses, and drives the `detail` line (the
 *            actual question / command / prompt).
 *   done   — attentionById records `done`: a turn finished while the user was
 *            not watching that chat (lib/chat's flagAttention).
 *   error  — attentionById records `error`: a turn failed.
 *
 * Dedupe: one row per stored id, and an `ask` beats a `done`/`error` for the
 * same chat — the blocking question is the actionable fact, "it finished" is
 * history. An `input` attention mark with no pending request left is the
 * question being answered (or the chat opened) while this app was away from
 * the map, so it still counts as `ask`: the block may be real, and the chat
 * resolves it on open.
 *
 * This file must stay free of react-native/expo imports: scripts/ runs it in
 * plain node for unit tests (same contract as attention / sessionRowMeta).
 * That is also why strings are passed in as a translator, not imported —
 * lib/strings pulls AsyncStorage + I18nManager at module scope.
 *
 * lib/chat DOES pull react-native/expo at module scope, so the pending map is
 * bridged in lazily (see hookInboxPending): the atoms below are the join's
 * only inputs, which keeps the module node-loadable while the app still gets
 * a live bridge with no extra caller wiring.
 */
import { atom, computed } from 'nanostores'
import { attentionById, type AttentionRecord } from './attention'
import { sessionRows } from './sessionList'
import { log } from './log'
import type { PendingRequest } from './chat'
import type { SessionRow } from './sessionRowMeta'

export type InboxKind = 'ask' | 'done' | 'error'

export interface InboxItem {
  kind: InboxKind
  /** Durable id — what `switchToSession` takes. */
  storedId: string
  /** The chat's title (preview fallback); '' when the row isn't loaded yet. */
  title: string
  /** Wall-clock ms of the event; 0 when the source carries no timestamp. */
  at: number
  /** One-line reason: the question/command for `ask`, the preview otherwise. */
  detail?: string
}

/** Hard cap on the rendered list — an inbox is a glance, not an archive. */
const MAX_ITEMS = 100
/** Detail lines render on ONE line; keep the payload reasonable. */
const MAX_DETAIL = 160

/** The join's inputs, injectable for tests (see `_setPendingForTests`). */
export interface InboxInputs {
  /** Stored id → that chat's unanswered server requests (chat.pendingByStoredId). */
  pending: Record<string, PendingRequest[]>
  /** Stored id → last attention state (attention.attentionById). */
  attention: Record<string, AttentionRecord>
  /** The server's conversation rows, for titles (sessionList.sessionRows). */
  rows: SessionRow[]
}

const oneLine = (v: string | undefined): string | undefined => {
  if (!v) return undefined
  const flat = v.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 1)}…` : flat
}

/** The human-readable reason a chat is asking — the question itself where the
 *  method carries one, else the command / description / prompt it is about. */
export function askDetail(req: PendingRequest | undefined): string | undefined {
  if (!req) return undefined
  switch (req.method) {
    case 'clarify': {
      // Batch clarifies carry no top-level `question` — the first sub-question
      // is the honest one-line summary.
      const first = req.questions?.find((q) => q.question)
      return oneLine(req.question) ?? oneLine(first?.question)
    }
    case 'approval':
      return oneLine(req.command) ?? oneLine(req.description) ?? oneLine(req.toolName)
    case 'sudo':
      return oneLine(req.prompt) ?? oneLine(req.command)
    case 'secret':
      return oneLine(req.prompt) ?? oneLine(req.envVar)
    default:
      return undefined
  }
}

function titleOf(row: SessionRow | undefined): string {
  const raw = row?.title?.trim()
  if (raw) return raw
  const preview = row?.preview?.replace(/\s+/g, ' ').trim()
  return preview ? preview.slice(0, 80) : ''
}

/**
 * The pure join: pending questions (ask) + attention (done/error) + titles.
 * Newest first, one row per chat (`ask` wins), capped at MAX_ITEMS.
 */
export function buildInboxItems({ pending, attention, rows }: InboxInputs): InboxItem[] {
  const byId = new Map<string, SessionRow>()
  for (const r of rows) {
    if (r?.id) byId.set(r.id, r)
  }

  const items: InboxItem[] = []
  const seen = new Set<string>()

  // 1) Questions actually awaiting an answer — the actionable ones.
  for (const [storedId, list] of Object.entries(pending)) {
    if (!storedId || !list?.length) continue
    seen.add(storedId)
    const row = byId.get(storedId)
    items.push({
      kind: 'ask',
      storedId,
      title: titleOf(row),
      // PendingRequest carries no timestamp; the attention mark does (it is
      // written in the same intake path). 0 sorts such rows last, honestly.
      at: attention[storedId]?.at ?? 0,
      detail: askDetail(list[0]) ?? oneLine(row?.preview),
    })
  }

  // 2) Everything else attention remembers about this stored id.
  for (const [storedId, rec] of Object.entries(attention)) {
    if (!storedId || seen.has(storedId)) continue
    const row = byId.get(storedId)
    if (rec.kind === 'input') {
      // No pending entry to detail it: the intake path writes `input` right
      // before filing the request, and retire() clears it when the last one
      // is answered — so this is a question that outlived the map (relaunch)
      // or one answered elsewhere. Still "needs you": opening the chat is
      // how it resolves.
      items.push({
        kind: 'ask',
        storedId,
        title: titleOf(row),
        at: rec.at ?? 0,
        detail: oneLine(row?.preview),
      })
      continue
    }
    items.push({
      kind: rec.kind,
      storedId,
      title: titleOf(row),
      at: rec.at ?? 0,
      detail: oneLine(row?.preview),
    })
  }

  items.sort((a, b) => b.at - a.at || a.storedId.localeCompare(b.storedId))
  return items.slice(0, MAX_ITEMS)
}

// ── Live sources ───────────────────────────────────────────────────────────

/** Stored id → pending requests. Bridged from chat.ts (see below). */
const pendingIn = atom<Record<string, PendingRequest[]>>({})

/** Tests inject the bridge input here; the app never calls this. */
export function _setPendingForTests(map: Record<string, PendingRequest[]>): void {
  pendingIn.set(map)
}

/** Every inbox row, newest first. Never empty-checks for you — the screen
 *  renders the empty state. */
export const inboxItems = computed([pendingIn, attentionById, sessionRows], (pending, attention, rows) =>
  buildInboxItems({ pending, attention, rows }),
)

/** What the nav badge shows: chats that actually BLOCK on the user. Finished
 *  and failed turns are informational — badging them would keep the count
 *  non-zero forever. */
export const inboxCount = computed(inboxItems, (items) => items.filter((i) => i.kind === 'ask').length)

export interface InboxGroups {
  ask: InboxItem[]
  done: InboxItem[]
  error: InboxItem[]
}

/** Split for the screen's three sections (order preserved: already newest first). */
export function groupInbox(items: InboxItem[]): InboxGroups {
  const out: InboxGroups = { ask: [], done: [], error: [] }
  for (const it of items) out[it.kind].push(it)
  return out
}

// ── Age labels ─────────────────────────────────────────────────────────────

/** `tr` from lib/strings, passed in so this module stays node-loadable. */
export type Translator = (key: string, vars?: Record<string, string | number>) => string

/** "just now" / "5m ago" / "3h ago" / "2d ago"; '' when there is no time. */
export function inboxAgeLabel(at: number, now: number, t: Translator): string {
  if (!at || !Number.isFinite(at) || at <= 0) return ''
  // BUG-058's lesson: clamp future/clock-skewed stamps instead of pinning a
  // negative diff at "just now" forever.
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return t('inbox.age.now')
  if (diff < 3_600_000) return t('inbox.age.minutes', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('inbox.age.hours', { n: Math.floor(diff / 3_600_000) })
  return t('inbox.age.days', { n: Math.floor(diff / 86_400_000) })
}

// ── Bridge to lib/chat ─────────────────────────────────────────────────────
//
// chat.ts imports AsyncStorage + react-native at module scope, so a static
// import here would make this file unloadable in plain node. The app always
// has chat in the graph (every shell imports it), so the dynamic import
// resolves from the module cache on the first tick; in node it rejects and
// the bridge stays empty, which is exactly what the unit tests want.

let bridged = false
let lastSig = ''

/** Identity of the pending map, cheap enough to run per notification. Keeps
 *  the inbox at REAL question edges: pendingByStoredId re-evaluates on every
 *  sessionsById flush (a streaming turn re-roots that atom every 33ms) and
 *  hands back a fresh object each time — forwarding that unchanged map would
 *  re-render the inbox at the token rate. */
function pendingSignature(map: Record<string, PendingRequest[]>): string {
  return Object.keys(map)
    .sort()
    .map((id) => `${id}:${map[id].map((r) => `${r.method}/${r.id}`).join(',')}`)
    .join('|')
}

/** Wire the live pending map into the inbox. Idempotent; runs on import so
 *  no caller (including the sidebar badge) can forget it. */
export function hookInboxPending(): void {
  if (bridged) return
  bridged = true
  void import('./chat')
    .then(({ pendingByStoredId }) => {
      const apply = (map: Record<string, PendingRequest[]>) => {
        const sig = pendingSignature(map)
        if (sig === lastSig) return
        lastSig = sig
        pendingIn.set(map)
      }
      apply(pendingByStoredId.get())
      pendingByStoredId.listen(apply)
    })
    .catch((err: unknown) => {
      // Node test runs land here by design (no RN in the loader).
      log('info', 'inbox', `pending bridge unavailable: ${err instanceof Error ? err.message : String(err)}`)
    })
}

hookInboxPending()
