import AsyncStorage from '@react-native-async-storage/async-storage'
import { log } from './log'
import type { ConnConfig } from './gateway'
import { resetSessionCaches, loadOutbox, OUTBOX_KEY } from './chat'
import { resetDrafts, loadDrafts, DRAFTS_KEY } from './drafts'
import { resetSendQueue, loadSendQueue, QUEUE_KEY } from './sendQueue'
import { resetChatMarks, MARKS_KEY } from './chatListState'
import { resetAttention, ATTENTION_KEY } from './attention'
import { resetSessionList } from './sessionList'
import { resetMediaState } from './mediaState'
import { wipeMediaCaches } from './mediaCache'

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
export async function syncBackendIdentity(c: ConnConfig): Promise<void> {
  const identity = backendIdentityOf(c)
  if (syncedThisRun === identity) return
  let stored: string | null = null
  try {
    stored = await AsyncStorage.getItem(IDENTITY_KEY)
  } catch {
    /* unreadable — treat as foreign and re-scope */
  }
  if (stored === identity) {
    syncedThisRun = identity
    return
  }
  // In-memory FIRST, through each cache's own reset helper.
  await resetSessionCaches()
  // BUG-031: media caches are keyed by PATH only — machine B must never
  // render machine A's cached bytes for a same-named gateway path. Wipe the
  // relay-media tree and the per-key states; correct bytes re-download on
  // view. expo-image's disk cache keys the same way — clear it too (dynamic
  // import keeps the app-only dependency out of node test graphs).
  await wipeMediaCaches()
  resetMediaState()
  try {
    const { Image } = await import('expo-image')
    await Image.clearDiskCache()
  } catch (err) {
    log('warn', 'identity', `expo-image cache clear failed: ${String(err)}`)
  }
  resetDrafts()
  resetSendQueue()
  resetChatMarks()
  resetAttention()
  resetSessionList()
  try {
    const previous = stored ?? 'legacy'
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
}
