import { atom } from 'nanostores'
import { rpc } from './gateway'
import { log } from './log'

/**
 * The server's conversation list.
 *
 * The sidebar used to build its list from the in-memory `sessionsById` store,
 * which has two fatal problems:
 *
 *  1. It only knows about conversations this app instance has touched, so
 *     every older chat was invisible in the drawer.
 *  2. It sorted by `lastSeq`, which is the gateway's PER-SESSION event counter.
 *     Each session numbers its own events from 1, so `seq 40` in one chat and
 *     `seq 3` in another say nothing about which is newer. New chats therefore
 *     landed in arbitrary positions.
 *
 * `session.list` is the real source: it covers every conversation Hermes has
 * stored, and `started_at` is a real wall-clock timestamp we can order by.
 */

export interface SessionRow {
  /** Durable id — the one `session.resume` takes. */
  id: string
  title?: string
  preview?: string
  /** Unix SECONDS, with a fractional part. */
  started_at?: number
  message_count?: number
  source?: string
}

/** Live id for each stored id, so overlays can be matched. */
const liveIds = atom<Record<string, string>>({})
export const sessionRows = atom<SessionRow[]>([])
export const sessionListLoading = atom(false)
export const sessionListError = atom<string | null>(null)

/** `started_at` is fractional seconds; be defensive about the unit. */
export function toMs(ts?: number | null): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  if (ts > 1e12) return ts // already milliseconds
  if (ts > 1e10) return ts // milliseconds on some backends
  return ts * 1000
}

/** Newest first, by wall clock. */
export function sortSessions(rows: SessionRow[]): SessionRow[] {
  return rows.slice().sort((a, b) => toMs(b.started_at) - toMs(a.started_at))
}

let inflight: Promise<SessionRow[]> | null = null

/**
 * Fetch the conversation list. Concurrent callers share one request so the
 * drawer and the Chats screen don't double-fetch on first paint.
 */
export function loadSessions(opts?: { force?: boolean }): Promise<SessionRow[]> {
  if (inflight && !opts?.force) return inflight

  inflight = (async () => {
    sessionListLoading.set(true)
    sessionListError.set(null)
    try {
      // `search` is NOT a valid param here (the contract is extra="forbid").
      const res = await rpc<{ sessions?: SessionRow[] }>('session.list', { limit: 200 })
      const rows = sortSessions(res?.sessions ?? [])
      sessionRows.set(rows)
      return rows
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load chats'
      sessionListError.set(msg)
      log('info', 'sessions', `session.list failed: ${msg}`)
      // Keep whatever we already had rather than blanking the list.
      return sessionRows.get()
    } finally {
      sessionListLoading.set(false)
      inflight = null
    }
  })()

  return inflight
}

/** Record that a stored id now has a live id bound in this app. */
export function bindLiveId(storedId: string, liveId: string) {
  if (!storedId || !liveId) return
  const map = liveIds.get()
  if (map[storedId] === liveId) return
  liveIds.set({ ...map, [storedId]: liveId })
}

export function liveIdFor(storedId: string): string | undefined {
  return liveIds.get()[storedId]
}

export function resetSessionList() {
  inflight = null
  sessionRows.set([])
  liveIds.set({})
  sessionListError.set(null)
}

/**
 * Optimistically insert a just-created chat so it appears immediately instead
 * of waiting for the next `session.list`. The server row replaces it later.
 */
export function upsertOptimisticRow(storedId: string, title: string) {
  if (!storedId) return
  const rows = sessionRows.get()
  const existing = rows.find((r) => r.id === storedId)
  if (existing) {
    if (existing.title !== title) {
      sessionRows.set(rows.map((r) => (r.id === storedId ? { ...r, title } : r)))
    }
    return
  }
  sessionRows.set(
    sortSessions([
      { id: storedId, title, started_at: Date.now() / 1000, message_count: 0, source: 'mobile' },
      ...rows,
    ]),
  )
}

/**
 * Live title sync: when a `session.title` / `session.info` event renames a
 * session mid-turn, patch the row so the drawer reads fresh without waiting
 * for the next `session.list` poll. Emitters carry different ids (stored key
 * vs live id), so accept candidates and match any row; unknown ids are
 * ignored — the next full fetch brings the row.
 */
export function patchRowTitle(candidates: Array<string | undefined>, title: string) {
  if (!title) return
  const rows = sessionRows.get()
  const ids = new Set(candidates.filter((x): x is string => !!x))
  const idx = rows.findIndex((r) => ids.has(r.id))
  if (idx < 0 || rows[idx].title === title) return
  const next = [...rows]
  next[idx] = { ...next[idx], title }
  sessionRows.set(next)
}
