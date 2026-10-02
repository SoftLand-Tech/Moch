import { atom } from 'nanostores'
import { log } from './log'

/**
 * Per-chat marks the gateway has no concept of: pinned + archived.
 *
 * The server's `session.list` is the source of truth for WHICH chats exist
 * (and their titles); this module only layers local organisation on top:
 *
 *  - `pinnedIds` / `archivedIds` persist in AsyncStorage and ride along next
 *    to every render of the chat list. Deleting a chat clears its marks.
 *  - `groupChats` is a pure function that turns (rows, marks, now) into the
 *    Pinned / Today / Yesterday / Previous 7 days / Older / Archived sections
 *    the sidebar renders, so the bucketing is unit-testable without RN.
 *
 * Rename does NOT live here: the title itself belongs to the server, and a
 * manual rename goes through the `session.title` RPC (manual titles carry
 * `user` provenance, which the auto-titler never overwrites).
 */

export const pinnedIds = atom<string[]>([])
export const archivedIds = atom<string[]>([])

export const MARKS_KEY = 'hermes.chatListMarks.v1'

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

function validIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []
}

export async function loadChatMarks(): Promise<void> {
  try {
    const s = await storage()
    const raw = await s.getItem(MARKS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { pinned?: unknown; archived?: unknown }
    pinnedIds.set(validIds(parsed.pinned))
    archivedIds.set(validIds(parsed.archived))
  } catch (err) {
    log('warn', 'chats', `load chat marks failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function persist() {
  const payload = JSON.stringify({ pinned: pinnedIds.get(), archived: archivedIds.get() })
  void storage()
    .then((s) => s.setItem(MARKS_KEY, payload))
    .catch((err) => log('warn', 'chats', `persist chat marks failed: ${err instanceof Error ? err.message : String(err)}`))
}

export function isPinned(id: string): boolean {
  return pinnedIds.get().includes(id)
}

export function isArchived(id: string): boolean {
  return archivedIds.get().includes(id)
}

/** Pin/unpin. Pinning pulls the chat out of the archive. */
export function togglePin(id: string) {
  const pinned = pinnedIds.get()
  if (pinned.includes(id)) {
    pinnedIds.set(pinned.filter((x) => x !== id))
  } else {
    pinnedIds.set([id, ...pinned])
    if (archivedIds.get().includes(id)) {
      archivedIds.set(archivedIds.get().filter((x) => x !== id))
    }
  }
  persist()
}

/** Archive/unarchive. Archiving unpins: the two states are exclusive. */
export function toggleArchive(id: string) {
  const archived = archivedIds.get()
  if (archived.includes(id)) {
    archivedIds.set(archived.filter((x) => x !== id))
  } else {
    archivedIds.set([id, ...archived])
    if (pinnedIds.get().includes(id)) {
      pinnedIds.set(pinnedIds.get().filter((x) => x !== id))
    }
  }
  persist()
}

/** Drop a chat's marks (after a delete) so they never resurface. */
export function forgetChatMarks(id: string) {
  const hadPin = pinnedIds.get().includes(id)
  const hadArchive = archivedIds.get().includes(id)
  if (hadPin) pinnedIds.set(pinnedIds.get().filter((x) => x !== id))
  if (hadArchive) archivedIds.set(archivedIds.get().filter((x) => x !== id))
  if (hadPin || hadArchive) persist()
}

/** Drop every pin/archive mark at once (backend switch — backendIdentity.ts).
 *  Marks are keyed by stored ids that belong to the machine that minted
 *  them. Storage removal is the identity sync's job; the immediate persist
 *  below is harmless — it re-reads the (now empty) atoms. */
export function resetChatMarks(): void {
  pinnedIds.set([])
  archivedIds.set([])
}

// ── Grouping ────────────────────────────────────────────────────────────────

export type ChatGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older' | 'archived'

export interface ChatGroup<T> {
  key: ChatGroupKey
  label: string
  items: T[]
}

export interface GroupableChat {
  id: string
  /** Wall-clock ms of the chat's latest activity; 0/undefined buckets to Older. */
  ts?: number
}

/** Start of the local calendar day containing `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const DAY_MS = 86_400_000

/**
 * Bucket chats into sidebar sections, newest first inside each section.
 * Pinned always leads, archived always trails (they are exclusive states —
 * the toggles enforce it — but if both somehow occur, pin wins). Empty
 * sections are omitted so the list never shows dead headers.
 */
export function groupChats<T extends GroupableChat>(
  items: T[],
  pinned: string[],
  archived: string[],
  now: number = Date.now(),
): ChatGroup<T>[] {
  const pinnedSet = new Set(pinned)
  const archivedSet = new Set(archived)

  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - DAY_MS
  const weekStart = todayStart - 6 * DAY_MS

  const byRecency = (a: T, b: T) => (b.ts ?? 0) - (a.ts ?? 0)
  const groups: Record<ChatGroupKey, T[]> = { pinned: [], today: [], yesterday: [], week: [], older: [], archived: [] }

  for (const item of items) {
    if (pinnedSet.has(item.id)) groups.pinned.push(item)
    else if (archivedSet.has(item.id)) groups.archived.push(item)
    else {
      const ts = item.ts ?? 0
      if (ts >= todayStart) groups.today.push(item)
      else if (ts >= yesterdayStart) groups.yesterday.push(item)
      else if (ts >= weekStart) groups.week.push(item)
      else groups.older.push(item)
    }
  }

  for (const list of Object.values(groups)) list.sort(byRecency)

  const labels: Record<ChatGroupKey, string> = {
    pinned: 'Pinned',
    today: 'Today',
    yesterday: 'Yesterday',
    week: 'Previous 7 days',
    older: 'Older',
    archived: 'Archived',
  }
  return (Object.keys(labels) as ChatGroupKey[])
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, label: labels[key], items: groups[key] }))
}
