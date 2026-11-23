import { atom } from 'nanostores'
import { log } from './log'
import { joinRunningSessions, type ActiveListSession } from './sessionRunning'
import { isBotSessionRow, optimisticSessionRow, type SessionRow } from './sessionRowMeta'
// Re-exported for every existing consumer; canonical definition (and its
// docs) lives in lib/sessionRowMeta so the scripts suites can import rows
// without pulling this module's gateway→RN graph into their tsconfig.
// (fleet stays a LAZY import below — a static one re-breaks node-loading.)
export type { SessionRow }
export { isBotSessionRow }
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
 * stored. Its rows arrive ordered by LAST ACTIVITY (`order_by_last_active=
 * True` server-side) and that order is authoritative — the client must NOT
 * re-sort by `started_at` (immutable creation time): doing so buried
 * actively-used old chats under newer-but-idle ones (BUG-012).
 */

/** Live id for each stored id, so overlays can be matched. */
const liveIds = atom<Record<string, string>>({})
export const sessionRows = atom<SessionRow[]>([])
export const sessionListLoading = atom(false)
export const sessionListError = atom<string | null>(null)
/** True when the last successful fetch was NOT truncated by the limit —
 *  only a complete list proves a session's ABSENCE (BUG-025 reconciliation
 *  must not prune chats that a truncated fetch simply didn't include). */
export const sessionListComplete = atom(false)

// ── Gateway-live "running" overlay (BUG-131, client half) ────────────────────
// Stored ids with a live session actively working ON THE GATEWAY right now —
// including sessions this app instance never opened (another device, the
// desktop app, a prior launch). Fetched from the previously-unused
// `session.active_list` RPC and joined against the loaded rows by the pure
// helper in lib/sessionRunning; refreshed alongside every session.list poll.
export const runningStoredIds = atom<ReadonlySet<string>>(new Set())

/**
 * Refresh the running overlay. Never throws: a failed call keeps the previous
 * set (the ≤60s poll retries) — the dot is an enhancement, never a blocker.
 */
export async function refreshRunningSessions(): Promise<void> {
  try {
    const res = await sessionRpc<{ sessions?: ActiveListSession[] }>('session.active_list', {})
    runningStoredIds.set(joinRunningSessions(res?.sessions, sessionRows.get()))
  } catch (err) {
    log('info', 'sessions', `session.active_list failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `started_at` is fractional seconds; be defensive about the unit. */
export function toMs(ts?: number | null): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  if (ts > 1e12) return ts // already milliseconds
  if (ts > 1e10) return ts // milliseconds on some backends
  return ts * 1000
}

// ── Local last-activity bumps (revive-to-top) ────────────────────────────────
// The server list orders by last activity, but its rows carry only the
// CREATION-time `started_at` — and the poll only refreshes every ~60s. So a
// revived old chat (a new prompt sent into it) stayed buried in "Older" in
// the drawer until a fresh fetch landed. These bumps are a LOCAL overlay:
// order only — the server refresh stays authoritative for content.

const LAST_ACTIVE_KEY = 'hermes.lastActiveMap.v1'
/** Cap, mirroring storedIdMap: bounded so the blob can't grow forever. */
const LAST_ACTIVE_CAP = 200

export const lastActiveByStoredId = atom<Record<string, number>>({})

/**
 * AsyncStorage is imported lazily (same contract as chatListState): scripts/
 * run in plain node where the RN package cannot load; tests inject a fake.
 */
type StorageLike = {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}
let storageOverride: StorageLike | null = null
/** Scripts inject a fake storage here; real apps never call this. */
export function _useLastActiveStorageForTests(s: StorageLike | null) {
  storageOverride = s
}
async function lastActiveStorage(): Promise<StorageLike> {
  if (storageOverride) return storageOverride
  const mod = (await import('@react-native-async-storage/async-storage')) as unknown as
    StorageLike & { default?: StorageLike }
  return mod.default ?? mod
}

// ── Lazy gateway/fleet access (same contract as the storage loader above) ───
// `./gateway` and `./fleet` pull AsyncStorage / expo / react-native in at
// MODULE SCOPE, so a static import makes this module unloadable in plain
// node — where the scripts/ suites exercise it. Both are imported lazily at
// the (async) call sites instead; in the app both are always in the bundle
// and the dynamic import resolves from the module cache.
type RpcFn = typeof import('./gateway')['rpc']
let rpcOverride: RpcFn | null = null
/** Scripts inject a fake RPC here (offline suites); real apps never do. */
export function _useSessionRpcForTests(r: RpcFn | null) {
  rpcOverride = r
}
async function sessionRpc<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  if (rpcOverride) return rpcOverride<T>(method, params, timeoutMs)
  const { rpc } = await import('./gateway')
  return rpc<T>(method, params, timeoutMs)
}

let lastActiveLoaded = false

export async function loadLastActive(): Promise<void> {
  if (lastActiveLoaded) return
  try {
    const s = await lastActiveStorage()
    const raw = await s.getItem(LAST_ACTIVE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') {
        const clean: Record<string, number> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) clean[k] = v
        }
        lastActiveByStoredId.set(clean)
      }
    }
  } catch (err) {
    log('warn', 'sessions', `load last-active failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  lastActiveLoaded = true
}

function persistLastActive() {
  const payload = JSON.stringify(lastActiveByStoredId.get())
  void lastActiveStorage()
    .then((s) => s.setItem(LAST_ACTIVE_KEY, payload))
    .catch(() => {
      /* best effort */
    })
}

/**
 * Record local activity on a chat: stamp Date.now() and MOVE its row to the
 * front of sessionRows so the drawer/Chats list reorders immediately, without
 * waiting for the ≤60s session.list poll. Content stays server-authoritative —
 * this only touches ORDER.
 */
export function bumpSessionActivity(storedId: string) {
  if (!storedId || storedId.startsWith('new:')) return
  const now = Date.now()
  const prev = lastActiveByStoredId.get()
  if (prev[storedId] !== now) {
    // Rebuild with the bumped key LAST (insertion order = recency), then cap.
    const entries = Object.entries(prev).filter(([k]) => k !== storedId)
    entries.push([storedId, now])
    const bounded = Object.fromEntries(entries.slice(-LAST_ACTIVE_CAP))
    lastActiveByStoredId.set(bounded)
    persistLastActive()
  }
  // Move the row (if present) to the front — order only.
  const rows = sessionRows.get()
  const idx = rows.findIndex((r) => r.id === storedId)
  if (idx > 0) {
    const row = rows[idx]
    sessionRows.set([row, ...rows.slice(0, idx), ...rows.slice(idx + 1)])
  }
}

/** The chat's locally-bumped last-activity ms, or 0 when never bumped. */
export function lastActiveFor(storedId: string): number {
  return lastActiveByStoredId.get()[storedId] ?? 0
}

let inflight: Promise<SessionRow[]> | null = null
// BUG-024/028: generation guard. A force refresh used to overwrite a still-
// running fetch's slot, and whichever finished first cleared the spinner and
// nulled `inflight` while the other was mid-flight — a third caller then
// started a third fetch, and a STALE response could overwrite fresher rows
// (or land after resetSessionList and repopulate the old backend's chats).
// Every load stamps itself; only the newest generation may write rows,
// clear the spinner, or null `inflight`.
let loadGen = 0

/** Rows fetched per call (BUG-020: was a silent 200 — the RPC contract has
 *  no maximum, so heavy users' older chats simply vanished; full cursor
 *  pagination is a gateway protocol addition, tracked in bugs.md). */
const LIST_LIMIT = 1000

/**
 * Fetch the conversation list. Concurrent callers share one request so the
 * drawer and the Chats screen don't double-fetch on first paint.
 */
export function loadSessions(opts?: { force?: boolean }): Promise<SessionRow[]> {
  if (inflight && !opts?.force) return inflight
  const gen = ++loadGen

  inflight = (async () => {
    sessionListLoading.set(true)
    sessionListError.set(null)
    try {
      // `search` is NOT a valid param here (the contract is extra="forbid").
      const res = await sessionRpc<{ sessions?: SessionRow[] }>('session.list', { limit: LIST_LIMIT })
      // Superseded (a newer force fetch, or a backend-switch reset) — never
      // write stale rows over fresher ones.
      if (gen !== loadGen) return sessionRows.get()
      // BUG-012: the server already orders rows by last activity
      // (order_by_last_active=True) — the old client re-sort by started_at
      // (immutable CREATION time) destroyed that order, so actively-used old
      // chats never rose to the top. Pass the server's order through.
      const rows = res?.sessions ?? []
      // Bot Mode (audit: BOT-MODE.md): this list is the LAUNCH PROFILE's
      // conversation list. Bot conversations are NOT sessions in it — every
      // bot is a Hermes profile with ONE canonical Bot Chat, reached through
      // the Bots roster / app/bot.tsx hand-off (`lib/botChat.ts`), and task
      // sessions inside a bot profile are Hermes-side workers, not chats.
      // (This replaces BUG-112's per-profile fan-out, which is what made bots
      // read as ordinary session folders.)
      //
      // The filter is load-bearing, not a tidy-up: the wire contract only
      // keeps bot rows out when the gateway honours it — a profile-scoped
      // row can still arrive here (peer gateways, rows restored from an
      // archive, a canonical Bot Chat whose hidden flag was lost), and every
      // Sessions surface renders THIS store. Dropping bot rows at the store
      // means no surface can leak them by forgetting its own filter; the
      // Bots surface never reads this store (it resolves canonical chats
      // through lib/botChat / profiles.list), so nothing is lost.
      const visible = rows.filter((r) => !isBotSessionRow(r))
      if (gen !== loadGen) return sessionRows.get()
      sessionRows.set(visible)
      // BUG-025: only a non-truncated list proves absence elsewhere — judged
      // on the RAW fetch, before the bot filter above shrinks it.
      sessionListComplete.set(rows.length < LIST_LIMIT)
      return visible
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load chats'
      if (gen === loadGen) sessionListError.set(msg)
      log('info', 'sessions', `session.list failed: ${msg}`)
      // Keep whatever we already had rather than blanking the list.
      return sessionRows.get()
    } finally {
      if (gen === loadGen) {
        sessionListLoading.set(false)
        inflight = null
      }
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
  // BUG-024: invalidate any in-flight fetch — a response from the OLD
  // backend landing after this reset must not repopulate the rows.
  loadGen++
  inflight = null
  sessionRows.set([])
  liveIds.set({})
  sessionListError.set(null)
  sessionListComplete.set(false)
  // Backend switch: live-session keys belong to the machine that minted
  // them — a running dot from the old gateway is noise here.
  runningStoredIds.set(new Set())
}

/**
 * Optimistically insert a just-created chat so it appears immediately instead
 * of waiting for the next `session.list`. The server row replaces it later.
 * BUG-012: a fresh chat IS the most recently active one — prepend it and let
 * the server's `order_by_last_active` ordering take over on the next fetch
 * (the old sortSessions re-sort by creation time buried actively-used old
 * chats under newer-but-idle ones).
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
  // BUG-074/#111: message_count stays UNDEFINED — the client cannot know it,
  // and the old `message_count: 0` made every fresh chat read "0 msgs" until
  // the next poll. The honest "— msgs" renders instead; the server row
  // replaces this one on the next session.list fetch (≤60s) — no bump
  // machinery, the poll self-heals it.
  sessionRows.set([optimisticSessionRow(storedId, title, Date.now() / 1000), ...rows])
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
