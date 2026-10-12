/**
 * v1→v2 transcript migration (BH-000024), extracted node-safe so the sweep
 * contract is pinnable in scripts/test-queue.ts: chat.ts itself cannot load
 * in plain node (react-native/AsyncStorage at import time), and the bug WAS
 * the sweep — the interim-key branch returned before the legacy live-keyed
 * half ran, stranding every live-keyed v1 blob forever.
 */

/** Storage seam — AsyncStorage in the app, an in-memory Map in tests. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/**
 * Live ids the stored-id map currently maps to `storedId`, NEWEST FIRST
 * (the map appends per resume, so the last pair holds the freshest vintage).
 * Pure: the caller owns the map (chat.ts keeps its 200-entry-bounded copy).
 */
export function legacyV1KeysFor(storedId: string, storedIdMap: Record<string, string>): string[] {
  return Object.entries(storedIdMap)
    .filter(([, st]) => st === storedId)
    .map(([live]) => live)
    .reverse()
}

/**
 * One-time v1→v2 migration, run lazily when a v2 read misses. v1 blobs were
 * keyed two ways: by a LIVE id (which rotates on every resume — one stored
 * chat routinely has several v1 keys of different vintages, the FRESHEST
 * under the most recently mapped live id) and, from an interim build, by the
 * stored id itself. Scan newest-first so a stale vintage never paints over
 * the last one written, and remove EVERY v1 key mapped to this stored id —
 * including in the interim branch, which must still sweep the legacy keys
 * before returning (BH-000024: the early return stranded them).
 * Returns the migrated payload (interim wins — it is the freshest format),
 * or null when no v1 blob exists for this stored id.
 */
export async function migrateV1TranscriptWith(
  storage: KeyValueStorage,
  storedId: string,
  keys: { v1: (id: string) => string; v2: (id: string) => string },
  storedIdMap: Record<string, string>,
): Promise<string | null> {
  try {
    // Interim-build key: stored-keyed but still .v1 — freshest format.
    const interim = await storage.getItem(keys.v1(storedId))
    if (interim) {
      await storage.setItem(keys.v2(storedId), interim)
      await storage.removeItem(keys.v1(storedId))
      // BH-000024: fall through to the legacy sweep's removal half — the
      // docstring's "remove EVERY v1 key mapped to this stored id" includes
      // live-keyed blobs even when the interim copy supplied the payload.
      for (const live of legacyV1KeysFor(storedId, storedIdMap)) {
        await storage.removeItem(keys.v1(live))
      }
      return interim
    }
    // Legacy: keyed by a live id that has since rotated. storedIdMap appends
    // per resume, so the LAST pair mapping here holds the newest write.
    const lives = legacyV1KeysFor(storedId, storedIdMap)
    let found: string | null = null
    for (const live of lives) {
      const raw = await storage.getItem(keys.v1(live))
      if (raw) {
        found = raw
        await storage.setItem(keys.v2(storedId), raw)
        break
      }
    }
    for (const live of lives) await storage.removeItem(keys.v1(live))
    return found
  } catch {
    return null
  }
}
