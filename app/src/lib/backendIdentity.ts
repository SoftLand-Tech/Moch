import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from './log'
import type { ConnConfig } from './gateway'
import { resetSessionCaches, loadOutbox, OUTBOX_KEY } from './chat'
import { resetDrafts, loadDrafts, DRAFTS_KEY } from './drafts'
import { resetSendQueue, loadSendQueue, QUEUE_KEY } from './sendQueue'
import { resetChatMarks, MARKS_KEY } from './chatListState'
import { resetAttention, ATTENTION_KEY } from './attention'
import { resetSessionList } from './sessionList'

/**
 * Which backend do this device's session caches belong to?
 *
 * Stored session ids are only meaningful to the backend that minted them, but
 * the device caches keyed by them are not: transcripts, drafts, the send
 * queue, chat marks, the stored-id map and the last-session pointer all
 * survive a re-pair, so a session id minted by machine A hydrates A's chat
 * contents after pairing to machine B (fully, on a lazy resume that returns
 * no messages) — and the queue/outbox flush would deliver A's unsent texts
 * into B's sessions as real prompts. This module fingerprints the CURRENT
 * pairing; when the fingerprint changes — or is missing, which counts as a
 * change so pre-existing installs re-scope once — every storedId-keyed cache
 * is re-scoped:
 *   - transcripts / marks / attention / session maps: PURGED. Server history
 *     re-hydrates on resume; the rest is device-local decoration.
 *   - drafts / send queue / outbox: SHELVED under the old fingerprint, never
 *     deleted — they are the user's own unsent words. Pairing back to that
 *     machine restores them (and their queues then flush to the right
 *     machine, which is where they were always meant to go).
 */

const IDENTITY_KEY = 'hermes.backendIdentity.v1'

/** User-content caches, shelved per backend instead of purged. */
const SHELFED_KEYS = [DRAFTS_KEY, QUEUE_KEY, OUTBOX_KEY] as const
const shelfKey = (base: string, id: string) => `${base}.orphan.${id}`

/** FNV-1a, hex. Not cryptographic — change detection only; the input is a
 *  high-entropy pairing, and a collision would merely skip one purge. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Fingerprint of a pairing: tls flag, host, token. Two rounds with
 *  different bases give 64 bits. The token rides in the HASH, never in
 *  storage — it belongs in SecureStore (gateway.ts keeps it out of even the
 *  redacted logs). Host alone cannot separate two machines behind one
 *  address (adb reverse, a re-pointed tailnet host); the token can. */
export function backendIdentityOf(c: ConnConfig): string {
  const raw = `${c.tls ? 1 : 0}|${c.host}|${c.token}`
  return `${fnv1a(raw)}${fnv1a(`\u0001${raw}`)}`
}

// Identity already synced this app run. Every dial re-checks (gateway's
// onDialConfig), and this turns the repeat calls — reconnect retries dial
// every few seconds while offline — into a no-op.
let syncedThisRun: string | null = null

/**
 * Compare the CURRENT pairing against the persisted fingerprint and re-scope
 * the backend-scoped caches when they disagree. Awaited at boot BEFORE
 * anything hydrates the caches (app/_layout.tsx), and re-run on every dial
 * via onDialConfig so mid-session re-pairs (deep link, saved-server switch)
 * re-scope too. The order matters: in-memory stores first (armed persist
 * debounces would re-write the old blobs from memory), then storage, then
 * the new fingerprint.
 */
/** BUG-032: single-flight for concurrent dials (boot connect vs deep link) —
 *  concurrent runs used to interleave the purge/shelve/restore sequence (the
 *  syncedThisRun guard is set only at the END), and the last finisher won
 *  IDENTITY_KEY even if the other dial owned the final socket. */
let inflightSync: Promise<void> | null = null

/** BUG-032: cap the per-backend shelves — every fingerprint change added up
 *  to three `*.orphan.<fp>` blobs that lived forever. Oldest sets evict. */
const MAX_BACKEND_SHELVES = 6
const SHELF_INDEX_KEY = 'hermes.shelfIndex.v1'

export async function syncBackendIdentity(c: ConnConfig): Promise<void> {
  if (inflightSync) {
    await inflightSync.catch(() => {})
    if (syncedThisRun === backendIdentityOf(c)) return
  }
  const run = (async () => {
    const identity = backendIdentityOf(c)
    if (syncedThisRun === identity) return
    let stored: string | null = null
    try {
      stored = await AsyncStorage.getItem(IDENTITY_KEY)
    } catch (err) {
      // BUG-032: an unreadable identity used to count as "foreign" and purge
      // EVERYTHING (transcripts, marks) on a transient storage error. Do
      // nothing instead — the next successful dial re-checks.
      log('warn', 'identity', `identity read failed — skipping re-scope this dial: ${String(err)}`)
      return
    }
    if (stored === identity) {
      syncedThisRun = identity
      return
    }
    // In-memory FIRST, through each cache's own reset helper.
    await resetSessionCaches()
    resetDrafts()
    resetSendQueue()
    resetChatMarks()
    resetAttention()
    resetSessionList()
    try {
      // BUG-032: on a FIRST-ever sync (no stored identity) shelve under the
      // REAL fingerprint — the old 'legacy' placeholder produced a shelf no
      // fingerprint could ever restore (the content was composed on THIS
      // device; it belongs to whatever machine this install pairs first).
      const previous = stored ?? identity
      // User content (drafts, queued sends, offline outbox) is never deleted:
      // shelve it under the backend it was composed for — pairing back to that
      // machine puts it back (restore below).
      for (const base of SHELFED_KEYS) {
        const raw = await AsyncStorage.getItem(base)
        if (raw && raw !== '{}' && raw !== '[]') {
          await AsyncStorage.setItem(shelfKey(base, previous), raw)
        }
        await AsyncStorage.removeItem(base)
      }
      // Cosmetic/decorative caches just go.
      await AsyncStorage.multiRemove([MARKS_KEY, ATTENTION_KEY])
      // Same machine again? Put its shelved words back before anything reads.
      for (const base of SHELFED_KEYS) {
        const sk = shelfKey(base, identity)
        const raw = await AsyncStorage.getItem(sk)
        if (raw !== null) {
          await AsyncStorage.setItem(base, raw)
          await AsyncStorage.removeItem(sk)
        }
      }
      // BUG-032: cap the shelves (LRU by fingerprint, oldest evicted) and
      // drop stale 'legacy' index entries — the pre-fix migration shelf is
      // promoted-by-fingerprint now and no real fp ever equals 'legacy'.
      const rawIndex = await AsyncStorage.getItem(SHELF_INDEX_KEY)
      let index: string[] = []
      try {
        const parsed = JSON.parse(rawIndex ?? '[]') as unknown
        if (Array.isArray(parsed)) index = parsed.filter((x): x is string => typeof x === 'string')
      } catch { /* corrupt index — rebuild */ }
      index = index.filter((fp) => fp !== previous && fp !== 'legacy')
      index.push(previous)
      while (index.length > MAX_BACKEND_SHELVES) {
        const evict = index.shift()
        if (!evict) break
        for (const base of SHELFED_KEYS) await AsyncStorage.removeItem(shelfKey(base, evict))
      }
      await AsyncStorage.setItem(SHELF_INDEX_KEY, JSON.stringify(index))
    } catch {
      /* best effort — a failed shelf must never block connecting */
    }
    syncedThisRun = identity
    try {
      await AsyncStorage.setItem(IDENTITY_KEY, identity)
    } catch {
      /* best effort */
    }
    // The restored/emptied stores live in module atoms hydrated at boot; a
    // mid-session switch has to re-read them from storage right now.
    try {
      await Promise.all([loadOutbox(), loadDrafts(), loadSendQueue()])
    } catch (err) {
      log('warn', 'identity', `cache reload after backend switch failed: ${String(err)}`)
    }
    log('info', 'identity', `paired backend changed (was ${stored ?? 'unrecorded'}) — session caches re-scoped`)
  })()
  inflightSync = run.finally(() => { inflightSync = null })
  return inflightSync
}
