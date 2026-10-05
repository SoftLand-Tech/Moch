import { atom } from 'nanostores'
import { log } from './log'

/**
 * The busy-queue: messages composed while a turn is running, keyed by STORED
 * session id, oldest first.
 *
 * Sending mid-turn no longer blocks or forces steer mode — it queues here
 * (harness-style). The flush driver in chat.ts releases the head the moment
 * the turn ends (turn-end events, answered questions, reconnect, session
 * resume); each released message starts a real turn whose own end releases
 * the next one.
 *
 * Same contract as drafts/chatListState/attention: no react-native imports —
 * scripts/ runs this in plain node.
 */

export interface QueuedSend {
  id: string
  text: string
  ts: number
}

export const QUEUE_KEY = 'hermes.sendQueue.v1'
const MAX_PER_CHAT = 20
const MAX_TEXT = 8000
const MAX_CHATS = 60
const PERSIST_DEBOUNCE_MS = 400

/** Queued messages per chat, oldest first. */
export const sendQueue = atom<Record<string, QueuedSend[]>>({})

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

let persistTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false

function persist() {
  dirty = true
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!dirty) return
    dirty = false
    void storage()
      .then((s) => s.setItem(QUEUE_KEY, JSON.stringify(sendQueue.get())))
      .catch((err) => log('warn', 'sendQueue', `persist failed: ${err instanceof Error ? err.message : String(err)}`))
  }, PERSIST_DEBOUNCE_MS)
}

function pruneChats(next: Record<string, QueuedSend[]>) {
  const keys = Object.keys(next)
  if (keys.length <= MAX_CHATS) return
  // Insertion order approximates recency; drop the oldest extras.
  for (const k of keys.slice(0, keys.length - MAX_CHATS)) delete next[k]
}

export async function loadSendQueue(): Promise<void> {
  try {
    const s = await storage()
    const raw = await s.getItem(QUEUE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const map: Record<string, QueuedSend[]> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (!Array.isArray(v)) continue
      const items = v
        .filter((x): x is QueuedSend =>
          !!x && typeof x === 'object' && typeof (x as QueuedSend).id === 'string' && typeof (x as QueuedSend).text === 'string')
        // Attachment-only sends queue with empty text, but their attachments
        // are memory-only (chat.ts owns the map) — after a restart an empty
        // item has nothing left to send, so it's dropped entirely.
        .filter((x) => x.text !== '')
        .map((x) => ({ id: x.id, text: x.text.slice(0, MAX_TEXT), ts: Number(x.ts) || Date.now() }))
      if (items.length) map[k] = items.slice(0, MAX_PER_CHAT)
    }
    sendQueue.set(map)
  } catch (err) {
    log('warn', 'sendQueue', `load failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A chat's queued messages, oldest first ('[]' when none). */
export function queueFor(storedId: string | null | undefined): QueuedSend[] {
  if (!storedId) return []
  return sendQueue.get()[storedId] ?? []
}

/**
 * Append a message to a chat's queue. Returns null (and keeps the queue
 * untouched) when the text is empty or the chat is at capacity — the caller
 * decides how to surface that. `allowEmpty` lets attachment-only sends
 * through with empty text (the attachments live in chat.ts's in-memory map,
 * keyed by the returned id; storage stays {id,text,ts}).
 */
export function enqueueSend(
  storedId: string | null | undefined,
  rawText: string,
  opts?: { allowEmpty?: boolean },
): QueuedSend | null {
  if (!storedId) return null
  const text = rawText.trim().slice(0, MAX_TEXT)
  if (!text && !opts?.allowEmpty) return null
  const cur = sendQueue.get()[storedId] ?? []
  if (cur.length >= MAX_PER_CHAT) {
    log('warn', 'sendQueue', `queue full for ${storedId}, dropping message`)
    return null
  }
  const item: QueuedSend = { id: `q${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text, ts: Date.now() }
  const next = { ...sendQueue.get(), [storedId]: [...cur, item] }
  pruneChats(next)
  sendQueue.set(next)
  persist()
  return item
}

/** Drop one queued message (removed, edited, or being re-sent another way). */
export function removeQueued(storedId: string | null | undefined, id: string): void {
  if (!storedId) return
  const cur = sendQueue.get()[storedId]
  if (!cur?.length) return
  const next = { ...sendQueue.get(), [storedId]: cur.filter((q) => q.id !== id) }
  if (!next[storedId].length) delete next[storedId]
  sendQueue.set(next)
  persist()
}

/** Oldest queued message, without removing it (the flush driver owns removal). */
export function peekQueued(storedId: string | null | undefined): QueuedSend | null {
  const list = queueFor(storedId)
  return list.length ? list[0] : null
}

/** Drop everything queued for one chat (chat deleted, etc.). */
export function clearSendQueue(storedId: string): void {
  const cur = sendQueue.get()
  if (!cur[storedId]) return
  const next = { ...cur }
  delete next[storedId]
  sendQueue.set(next)
  persist()
}

/** Drop every chat's queue at once (backend switch — backendIdentity.ts).
 *  Queued prompts are keyed by stored ids that belong to the machine that
 *  minted them; flushing them at a different backend would deliver them to
 *  the wrong machine. Storage removal is the identity sync's job; here we
 *  only empty the atom and cancel the debounced write, which re-reads the
 *  atom at fire time and would otherwise re-persist the old map. */
export function resetSendQueue(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  dirty = false
  sendQueue.set({})
}

/** Flush a pending debounced write now (used by tests). */
export async function flushSendQueue(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!dirty) return
  dirty = false
  await storage().then((s) => s.setItem(QUEUE_KEY, JSON.stringify(sendQueue.get())))
}
