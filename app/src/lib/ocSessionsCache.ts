/**
 * The drawer's OpenCode session list cache (OPENCODE-MODE).
 *
 * Lives here — NOT in Sidebar.tsx — so the chat transport can invalidate it
 * when turns create/rename sessions, without a component→store import cycle
 * (Sidebar imports chat.ts for openOcChat).
 */
import type { OcSession } from './opencodeClient'

const TTL_MS = 15_000

let rows: OcSession[] | null = null
let at = 0

/** Valid cache within the TTL, else null (caller fetches + stores). */
export function ocSessionsCached(): OcSession[] | null {
  if (rows && Date.now() - at < TTL_MS) return rows
  return null
}

/** Even a fresh cache is stale after a turn created/renamed a session. */
export function invalidateOcSessionsCache(): void {
  rows = null
  at = 0
}

export function ocSessionsStore(next: OcSession[]): void {
  rows = next
  at = Date.now()
}
