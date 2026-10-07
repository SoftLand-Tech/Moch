import { atom } from 'nanostores'
import { log } from './log'

/**
 * Per-chat composer drafts, keyed by STORED session id.
 *
 * Jumping between conversations (or following an attention toast) must never
 * cost the text the user was still typing: the composer mirrors its value
 * here on every change and rehydrates from it when the active chat changes.
 * Persisted so an unfinished thought survives a full app restart.
 *
 * Same contract as chatListState/attention: no react-native imports —
 * scripts/ runs this in plain node.
 */

export const DRAFTS_KEY = 'hermes.drafts.v1'
const MAX_DRAFTS = 60
const PERSIST_DEBOUNCE_MS = 400

export const drafts = atom<Record<string, string>>({})

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
  // Keystroke-rate calls must not be keystroke-rate disk writes; the atom is
  // the source of truth, storage only needs to catch up eventually.
  dirty = true
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!dirty) return
    dirty = false
    void storage()
      .then((s) => s.setItem(DRAFTS_KEY, JSON.stringify(drafts.get())))
      .catch((err) => log('warn', 'drafts', `persist failed: ${err instanceof Error ? err.message : String(err)}`))
  }, PERSIST_DEBOUNCE_MS)
}

export async function loadDrafts(): Promise<void> {
  try {
    const s = await storage()
    const raw = await s.getItem(DRAFTS_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v) map[k] = v
    }
    drafts.set(map)
  } catch (err) {
    log('warn', 'drafts', `load failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Current draft for a chat ('' when none). */
export function draftFor(storedId: string | null | undefined): string {
  if (!storedId) return ''
  return drafts.get()[storedId] ?? ''
}

/** Save (or clear, on empty) a chat's draft. */
export function setDraft(storedId: string | null | undefined, text: string): void {
  if (!storedId) return
  const map = drafts.get()
  const had = map[storedId]
  if (!text) {
    if (!had) return
    const next = { ...map }
    delete next[storedId]
    drafts.set(next)
    persist()
    return
  }
  if (had === text) return
  // BUG-065: delete-then-set refreshes the chat's insertion-order slot, so
  // the eviction cap drops the LEAST-RECENTLY-active chat's draft.
  const next = { ...map }
  delete next[storedId]
  next[storedId] = text.slice(0, 8000)
  const keys = Object.keys(next)
  if (keys.length > MAX_DRAFTS) {
    // Drop the least-recently-updated extras (insertion order after the
    // refresh above is true recency order).
    for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) delete next[k]
  }
  drafts.set(next)
  persist()
}

export function clearDraft(storedId: string): void {
  setDraft(storedId, '')
}

/** Drop every draft at once (backend switch — backendIdentity.ts). Drafts are
 *  keyed by stored ids that mean nothing to a different machine. Storage
 *  removal is the identity sync's job; here we only empty the atom and cancel
 *  the debounced write, which re-reads the atom at fire time and would
 *  otherwise re-persist the old map. */
export function resetDrafts(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  dirty = false
  drafts.set({})
}

/** Flush a pending debounced write now (used by tests). */
export async function flushDrafts(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!dirty) return
  dirty = false
  await storage().then((s) => s.setItem(DRAFTS_KEY, JSON.stringify(drafts.get())))
}
