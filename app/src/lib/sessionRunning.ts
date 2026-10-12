/**
 * BUG-131 (client half): which Chats rows are running ON THE GATEWAY right now.
 *
 * `busyStoredKey` (lib/chat) only knows about sessions THIS app instance
 * opened — its busy set is fed by the resume/stream events of chats we hold
 * live handles for. A turn running in a session this app never opened
 * (started on the desktop app, another phone, or a prior launch of this one
 * before a kill/restart) therefore rendered as an ordinary idle row.
 *
 * The gateway's `session.active_list` RPC (tui_gateway/contracts/sessions.py
 * — live sessions in the process, with `session_key` = the agent's DURABLE
 * stored id and a `status` of working/streaming/starting/waiting/resuming/
 * idle) answers exactly this, and had zero callers in the app. This module
 * holds the pure join so it is node-testable; the fetch + atom live in
 * lib/sessionList next to the rows it is joined against.
 *
 * This file must stay free of react-native/expo imports (same contract as
 * chatListState / attention): scripts/ runs it in plain node for unit tests.
 */

/** Shape of one `session.active_list` row, before any validation. */
export interface ActiveListSession {
  /** Durable stored id — the same key `session.list` rows use as `id`. */
  session_key?: unknown
  /** A LiveSessionStatus wire value. */
  status?: unknown
}

/**
 * Statuses that mean "a turn is in flight" — the row deserves the busy dot.
 * `idle` is open-but-quiet; `waiting` is deliberately EXCLUDED: it means the
 * agent asked the user something, which the existing attention/pending
 * machinery already surfaces (amber input dot) — a cyan "working" pulse on
 * top of that would lie twice.
 */
const RUNNING_STATUSES = new Set(['working', 'streaming', 'starting', 'resuming'])

/**
 * Pure join: which of `rows` have a gateway-live session actively working.
 *
 * Only ids that actually match a loaded row are returned (an active session
 * with no row — e.g. outside the fetched window — has nothing to mark), and
 * defensive per-item validation keeps a malformed gateway answer from
 * poisoning the set.
 */
export function joinRunningSessions(
  activeList: readonly ActiveListSession[] | null | undefined,
  rows: ReadonlyArray<{ id: string }>,
): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(activeList)) return out
  for (const a of activeList) {
    if (!a || typeof a !== 'object') continue
    const key = typeof a.session_key === 'string' ? a.session_key : ''
    const status = typeof a.status === 'string' ? a.status : ''
    if (!key || !RUNNING_STATUSES.has(status)) continue
    for (const r of rows) {
      if (r.id === key) {
        out.add(r.id)
        break
      }
    }
  }
  return out
}
