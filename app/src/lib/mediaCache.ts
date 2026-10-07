import { File, Paths, Directory } from 'expo-file-system'
import * as LegacyFileSystem from 'expo-file-system/legacy'
import { connConfig, type ConnConfig } from './gateway'
import { httpBase } from './http'
import { log } from './log'
import { cacheKeyFor, mediaKindForPath, planCachePrune, type MediaKind } from './media'
import { setMediaState } from './mediaState'

/**
 * Receive-side media transport. All bytes ride authenticated HTTP:
 *  - images  → GET /api/files/download?path=… (raw Range-aware bytes), fed
 *              straight to expo-image with `headers` + `cacheKey`; its disk
 *              cache owns them (relay-media never stores images).
 *  - video   → GET /api/files/stream?path=… streamed by expo-video.
 *  - audio +
 *    files   → File.createDownloadTask into `Paths.cache/relay-media`.
 *
 * Statuses are read from raw fetch (NOT apiFetch, which folds the status
 * into the error message) so 403/404/413 map to real sentences. The 403
 * denylist (config.yaml, .env*, credentials, mcp-tokens/, pairing/) and the
 * 100 MB managed cap both surface through these mappings.
 */

const RELAY_MEDIA_DIR = 'relay-media'

// ── URLs / sources ─────────────────────────────────────────────────────────

export function authHeaders(c: ConnConfig = requireConfig()): Record<string, string> {
  return { 'X-Hermes-Session-Token': c.token }
}

/** expo-image source for a gateway image: auth headers + a stable cacheKey
 *  (pass cachePolicy="disk" on the <Image> itself). */
export function imageSource(
  path: string,
  c: ConnConfig = requireConfig(),
): { uri: string; headers: Record<string, string>; cacheKey: string } {
  return {
    uri: `${httpBase(c)}/api/files/download?path=${encodeURIComponent(path)}`,
    headers: authHeaders(c),
    cacheKey: cacheKeyFor(path),
  }
}

/** expo-video source — streamed, never copied to disk first. */
export function videoSource(
  path: string,
  c: ConnConfig = requireConfig(),
): { uri: string; headers: Record<string, string>; contentType: 'progressive' } {
  return {
    uri: `${httpBase(c)}/api/files/stream?path=${encodeURIComponent(path)}`,
    headers: authHeaders(c),
    contentType: 'progressive',
  }
}

function requireConfig(): ConnConfig {
  const c = connConfig.get()
  if (!c) throw new Error('Not connected')
  return c
}

/** Hermes-safe AbortError (no DOMException on the native runtime). */
function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

// ── Error mapping (files.py guard semantics) ───────────────────────────────

/** 403 = sensitive-basename denylist / outside media roots; 404 = deleted;
 *  413 = the gateway's 100 MB managed-file cap. */
export function mediaErrorForStatus(status: number): string {
  if (status === 403) return 'Blocked by gateway policy'
  if (status === 404) return 'No longer on gateway'
  if (status === 413) return 'Too large for gateway'
  if (status === 415) return 'Not a media file'
  return `Gateway returned HTTP ${status}`
}

// ── Image data-URL fallback (files under HERMES_HOME/{images,screenshots,cache}) ──

/**
 * Plausibly under the /api/media serve roots (`get_hermes_home()`/
 * {images,screenshots,cache} — the default Hermes home is `~/.hermes`). A
 * path-shape heuristic: a custom home simply skips the fallback (and gets the
 * primary error mapped) instead of a guaranteed 403. Every mobile UPLOAD
 * lands in `<root>/relay-uploads/`, outside the roots, where /api/media can
 * only answer 403 — running the fallback there would mask the real failure.
 */
export function isMediaRootPath(path: string): boolean {
  return /(?:^|\/)\.hermes\/(?:images|screenshots|cache)\//i.test(path)
}

/**
 * When the direct download URL errors, /api/media serves eligible images as
 * a base64 data URL. Raw fetch + res.status: on failure the mapped error is
 * thrown; on success the caller gets an inline data URI for expo-image.
 */
export async function imageFallbackDataUrl(path: string, c: ConnConfig = requireConfig()): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(`${httpBase(c)}/api/media?path=${encodeURIComponent(path)}`, {
      headers: authHeaders(c),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(mediaErrorForStatus(res.status))
    const body = (await res.json()) as { data_url?: string }
    if (!body.data_url) throw new Error('Gateway returned no image data')
    return body.data_url
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One cheap ranged GET of the primary download URL so the REAL gateway
 * status maps to the bubble's error (404 deleted, 403 policy, 413 cap…)
 * instead of a masked fallback message. Headers only — the body is aborted
 * the moment the status lands. Network failures resolve to null (the caller
 * shows its generic message).
 */
export async function probeDownloadError(path: string, c: ConnConfig = requireConfig()): Promise<string | null> {
  const probe = new AbortController()
  const timer = setTimeout(() => probe.abort(), 15_000)
  try {
    const res = await fetch(`${httpBase(c)}/api/files/download?path=${encodeURIComponent(path)}`, {
      headers: { ...authHeaders(c), Range: 'bytes=0-0' },
      signal: probe.signal,
    })
    const status = res.status
    probe.abort()
    if (status === 200 || status === 206) return null
    return mediaErrorForStatus(status)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Write an inline data-URL image to a cache file so the share sheet gets a
 * real file:// uri (share targets need files, not `data:` strings). One
 * timestamp-named file per call — the OS owns the cache dir's lifetime.
 */
export async function dataUrlToLocalFile(dataUrl: string): Promise<string | null> {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/i.exec(dataUrl)
  if (!m?.[1] || !m[2]) return null
  const sub = m[1].split('+')[0]?.split(';')[0] ?? ''
  const ext = sub === 'image/jpeg' ? 'jpg' : sub.replace('image/', '') || 'jpg'
  const uri = `${LegacyFileSystem.cacheDirectory ?? ''}relay-inline-${Date.now()}.${ext}`
  await LegacyFileSystem.writeAsStringAsync(uri, m[2], { encoding: LegacyFileSystem.EncodingType.Base64 })
  return uri
}

// ── Download to relay-media/ ───────────────────────────────────────────────

function relayMediaDir(): Directory {
  const dir = new Directory(Paths.cache, RELAY_MEDIA_DIR)
  if (!dir.exists) dir.create({ idempotent: true })
  return dir
}

/**
 * BUG-031: media caches are keyed by PATH only, so after switching to a
 * different machine a same-named gateway path would render the PREVIOUS
 * machine's cached bytes (audio/docs would play A's recordings for B's
 * filenames). The backend-identity switch wipes the relay-media tree; the
 * correct bytes simply re-download on view. (expo-image's disk cache is
 * cleared by the caller — kept out of this module's static graph.)
 */
export async function wipeMediaCaches(): Promise<void> {
  try {
    const dir = new Directory(Paths.cache, RELAY_MEDIA_DIR)
    if (dir.exists) dir.delete()
  } catch (err) {
    log('warn', 'media', `relay-media wipe failed: ${String(err)}`)
  }
}

/** Local file for a gateway path, downloading on miss. Filename is
 *  `cacheKeyFor(path)` — no index store; existence IS the cache. */
export function localMediaPath(path: string): string {
  const key = cacheKeyFor(path)
  // Keep the extension so players/mime detection keep working.
  return `${new Directory(Paths.cache, RELAY_MEDIA_DIR).uri}/${key}`
}

/**
 * Fetch a gateway file (audio, docs, anything non-streamed) into relay-media
 * and return its local file:// uri. Progress lands in the mediaState store
 * under cacheKeyFor(path). Throws with a mapped message on gateway errors.
 */
export async function downloadMediaFile(path: string, opts?: { signal?: AbortSignal }): Promise<string> {
  const c = requireConfig()
  const key = cacheKeyFor(path)
  const dest = new File(relayMediaDir(), key)
  if (dest.exists) {
    setMediaState(key, { status: 'ready', uri: dest.uri })
    return dest.uri
  }
  const url = `${httpBase(c)}/api/files/download?path=${encodeURIComponent(path)}`
  setMediaState(key, { status: 'loading', received: 0, total: null })
  try {
    // Status preflight (raw fetch): abort the body the moment the headers
    // land — the bytes are fetched for real by the task below, with progress.
    const probe = new AbortController()
    const res = await fetch(url, { headers: authHeaders(c), signal: probe.signal })
    if (!res.ok) throw new Error(mediaErrorForStatus(res.status))
    probe.abort()
    if (opts?.signal?.aborted) throw abortError()

    let lastTick = 0
    const task = File.createDownloadTask(url, dest, {
      headers: authHeaders(c),
      signal: opts?.signal,
      onProgress: (p) => {
        const now = Date.now()
        // Throttle store writes to 5 Hz — a 200-tick/s native callback would
        // re-render every subscribed chip at stream rate for no gain.
        if (now - lastTick < 200 && p.totalBytes >= 0 && p.bytesWritten < p.totalBytes) return
        lastTick = now
        setMediaState(key, { status: 'loading', received: p.bytesWritten, total: p.totalBytes < 0 ? null : p.totalBytes })
      },
    })
    const file = await task.downloadAsync()
    if (!file) throw new Error('Download paused')
    setMediaState(key, { status: 'ready', uri: file.uri })
    return file.uri
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      setMediaState(key, { status: 'idle' })
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    setMediaState(key, { status: 'error', message, kind: mediaKindForPath(path) === 'unknown' ? 'file' : (mediaKindForPath(path) as MediaKind) })
    try { if (dest.exists) dest.delete() } catch { /* best effort */ }
    log('warn', 'media', `download failed (${path}): ${message}`)
    throw err
  }
}

// ── Cold-start prune ───────────────────────────────────────────────────────

const PRUNE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_MAX_BYTES = 200_000_000 // kB=1000 B basis, like every cap in media.ts

/** Age out relay-media (> 7 days), then trim oldest-first past 200 MB.
 *  Images are expo-image's disk cache's business and never appear here. */
export function pruneRelayMedia(): void {
  try {
    const dir = new Directory(Paths.cache, RELAY_MEDIA_DIR)
    if (!dir.exists) return
    const files: Array<{ path: string; mtimeMs: number; size: number; file: File }> = []
    for (const entry of dir.list()) {
      if (entry instanceof Directory) continue
      const info = entry.info({ md5: false })
      if (!info.exists || typeof info.size !== 'number') continue
      files.push({
        path: entry.uri,
        // modificationTime is milliseconds since epoch (SDK 57 FileSystem).
        mtimeMs: info.modificationTime ?? 0,
        size: info.size,
        file: entry,
      })
    }
    const doomed = new Set(planCachePrune(files, { maxAgeMs: PRUNE_MAX_AGE_MS, maxBytes: PRUNE_MAX_BYTES }))
    for (const f of files) {
      if (!doomed.has(f.path)) continue
      try {
        f.file.delete()
      } catch { /* best effort */ }
    }
    if (doomed.size) log('info', 'media', `pruned ${doomed.size} relay-media file(s)`)
  } catch (err) {
    log('warn', 'media', `prune failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
