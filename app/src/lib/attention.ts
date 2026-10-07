import { atom } from 'nanostores'
import { log } from './log'

/**
 * Per-chat attention states — "this conversation needs you".
 *
 * The gateway streams events for every live session on the one socket, so a
 * turn can finish (or stall on a question) in a chat the user is NOT looking
 * at. This module records that as a tri-state badge keyed by STORED session id
 * (the stable key the sidebar rows and `session.list` use — live ids change on
 * every resume):
 *
 *   input — the agent asked something (approval / clarify / sudo / secret)
 *   done  — a turn finished while the chat was not being viewed
 *   error — the turn failed
 *
 * The map persists to AsyncStorage so the badges survive a relaunch (a chat
 * that finished while the phone was closed is still green until opened).
 * Opening a chat clears its badge (`resumeSession` calls `clearAttention`).
 *
 * This file must stay free of react-native/expo imports: scripts/ runs it in
 * plain node for unit tests (same contract as chatListState).
 */

export type AttentionKind = 'input' | 'done' | 'error'
/** What a chat-list row should render: an attention state beats "working". */
export type RowStatus = AttentionKind | 'busy'

export interface AttentionRecord {
  kind: AttentionKind
  /** Wall-clock ms of the last attention change. */
  at: number
}

export const ATTENTION_KEY = 'hermes.attention.v1'
const MAX_TRACKED = 100

export const attentionById = atom<Record<string, AttentionRecord>>({})

// ── In-app toasts (foreground counterpart of a push notification) ──────────

export interface SessionToast {
  id: number
  kind: AttentionKind
  /** Event title — "Approval needed", "Agent replied", "Turn failed". */
  title: string
  body: string
  storedId: string
  /** Chat title at event time, shown as the toast's kicker. */
  chatTitle?: string
}

export const toasts = atom<SessionToast[]>([])

let toastSeq = 0

/** Queue a toast. Newest renders on TOP (BUG-026: it used to append, so the
 *  newest card hid UNDER older ones); a newer toast for the same chat+kind
 *  replaces the old one IN PLACE (same React key — no unmount/remount
 *  flash); at most three are on screen (oldest dropped). */
export function pushToast(t: Omit<SessionToast, 'id'>): void {
  const existing = toasts.get()
  const idx = existing.findIndex((x) => x.storedId === t.storedId && x.kind === t.kind)
  if (idx >= 0) {
    const next = [...existing]
    next[idx] = { ...existing[idx], ...t, id: existing[idx].id }
    toasts.set(next)
    return
  }
  toasts.set([{ ...t, id: ++toastSeq }, ...existing].slice(0, 3))
}

export function dismissToast(id: number): void {
  const list = toasts.get()
  if (!list.some((x) => x.id === id)) return
  toasts.set(list.filter((x) => x.id !== id))
}

// ── Deep-link target ────────────────────────────────────────────────────────

export interface PendingOpen {
  storedId: string
  /** Set time — stale targets (app took >60s to connect) are ignored. */
  at: number
}

/** Chat the user asked to land in (toast tap, notification tap). The root
 *  layout consumes it once the gateway connection is up and switches. */
export const pendingOpenStoredId = atom<PendingOpen | null>(null)

export function requestOpenSession(storedId: string): void {
  if (storedId) pendingOpenStoredId.set({ storedId, at: Date.now() })
}

/** True while the chat tab is actually on screen. The chat screen keeps this
 *  current so attention dispatch can tell "that session is being watched"
 *  from "it's the active session but the user is on another tab". */
export const chatTabFocused = atom(false)

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * AsyncStorage is imported lazily: scripts/ runs in plain node, where the RN
 * package cannot load. Tests inject a fake here before calling anything that
 * persists.
 */
type StorageLike = {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}
let storageOverride: StorageLike | null = null
/** Scripts inject a fake storage here; real apps never call this. */
export function _useStorageForTests(s: StorageLike | null) {
  storageOverride = s
}
async function storage(): Promise<StorageLike> {
  if (storageOverride) return storageOverride
  const mod = (await import('@react-native-async-storage/async-storage')) as unknown as
    StorageLike & { default?: StorageLike }
  return mod.default ?? mod
}

function persist() {
  void storage()
    .then((s) => s.setItem(ATTENTION_KEY, JSON.stringify(attentionById.get())))
    .catch((err) => log('warn', 'attention', `persist failed: ${err instanceof Error ? err.message : String(err)}`))
}

function validRecord(v: unknown): AttentionRecord | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind !== 'input' && o.kind !== 'done' && o.kind !== 'error') return null
  return { kind: o.kind, at: typeof o.at === 'number' ? o.at : 0 }
}

export async function loadAttention(): Promise<void> {
  try {
    const s = await storage()
    const raw = await s.getItem(ATTENTION_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const map: Record<string, AttentionRecord> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const rec = validRecord(v)
      if (rec) map[k] = rec
    }
    attentionById.set(map)
  } catch (err) {
    log('warn', 'attention', `load failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function markAttention(storedId: string, kind: AttentionKind): void {
  if (!storedId) return
  const map = { ...attentionById.get() }
  map[storedId] = { kind, at: Date.now() }
  const entries = Object.entries(map)
  if (entries.length > MAX_TRACKED) {
    entries.sort((a, b) => a[1].at - b[1].at)
    for (const [k] of entries.slice(0, entries.length - MAX_TRACKED)) delete map[k]
  }
  attentionById.set(map)
  persist()
}

export function clearAttention(storedId: string): void {
  const map = attentionById.get()
  if (!map[storedId]) return
  const next = { ...map }
  delete next[storedId]
  attentionById.set(next)
  persist()
}

/** Drop every attention record at once (backend switch — backendIdentity.ts).
 *  Records are keyed by stored ids that belong to the machine that minted
 *  them; a badge pointing at another backend's chat is noise. Storage
 *  removal is the identity sync's job; the immediate persist below is
 *  harmless — it re-reads the (now empty) atom. */
export function resetAttention(): void {
  attentionById.set({})
}

// ── Row status ──────────────────────────────────────────────────────────────

/** A chat-list row's dot: an attention state outranks the "working" pulse. */
export function rowStatus(busy: boolean, a?: AttentionRecord, pending?: boolean): RowStatus | undefined {
  if (a) return a.kind
  // BUG-085: an unanswered question keeps its amber dot even after the chat
  // was opened (opening clears the event-driven 'input' mark) — the question
  // is still blocking, so the row must keep saying so.
  if (pending) return 'input'
  return busy ? 'busy' : undefined
}
