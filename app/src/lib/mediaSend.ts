import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as FileSystem from 'expo-file-system/legacy'
import { connConfig, rpc, type ConnConfig } from './gateway'
import { apiFetch, httpBase } from './http'
import { log } from './log'
import { JsonRpcGatewayError } from '../protocol/json-rpc-channel'
import {
  ATTACH_AUTO_APPROVE_BYTES,
  ATTACH_MAX_BYTES,
  ATTACH_RATE_KBPS,
  formatBytes,
  mediaKindForPath,
  mimeForPath,
  sanitizeBasename,
  uploadTimeoutMs,
} from './media'

/**
 * Send-side media transport. All bytes ride HTTP — never the ordered WS
 * socket (an in-band >45 s frame would trip the heartbeat and kill it):
 *
 *   1. images   → JPEG ladder (1568 px/q0.75 → 1024 px/q0.6, hard-fail —
 *                 never a raw .heic), uploaded named `*.jpg` (the gateway's
 *                 image allowlist excludes HEIC).
 *   2. upload   → POST /api/files/upload-stream, multipart `file` + absolute
 *                 `path` Form (the managed route 400s relative paths). The
 *                 target root comes from GET /api/files meta once per host;
 *                 an unlocked gateway answers `root: null` and we fall back
 *                 to `~/relay-uploads/…` (expanded server-side).
 *   3. attach   → image.attach {path} / file.attach {path,name} — BEFORE
 *                 prompt.submit (mirrors the desktop's withSessionNotFound
 *                 Resume ordering). file.attach returns `ref_text`
 *                 (`@file:…`) which the caller appends to the prompt text.
 *
 * On any failure after ≥ 1 image.attach succeeded, every attached image is
 * detached (image.detach) so the gateway session never keeps orphaned
 * attachments from a failed send.
 */

export interface PendingAttachment {
  id: string
  /** Pick-time classification (drives image-ladder + attach RPC choice). */
  kind: 'image' | 'video' | 'audio' | 'file'
  /** Local file:// uri (picker output / ladder output). */
  uri: string
  name: string
  size?: number
  mime?: string
  /** Picker-reported dimensions — let the ladder skip its dims probe. */
  width?: number
  height?: number
  state: 'pick' | 'preparing' | 'uploading' | 'ready' | 'failed'
  error?: string
  /** Gateway-absolute path once uploaded (also the segment's path). */
  path?: string
}

export interface AttachOutcome {
  /** `ref_text` values from file.attach, in attachment order. */
  refTexts: string[]
  /** Gateway paths of successfully attached images (detach-cleanup list). */
  attachedImagePaths: string[]
  /** attachment id → gateway path. */
  pathsById: Record<string, string>
}

// ── Managed root ───────────────────────────────────────────────────────────

let rootCache: { host: string; root: string } | null = null

/**
 * The managed-files root uploads must live under, resolved once per host.
 * The default policy is unlocked (`root: null`) — `~/relay-uploads/…` then
 * expands server-side via Path.expanduser(). Under a locked root the meta
 * carries the root and uploads land inside it.
 */
export async function resolveManagedRoot(): Promise<string> {
  const c = connConfig.get()
  if (!c) throw new Error('Not connected')
  if (rootCache && rootCache.host === c.host) return rootCache.root
  let root = '~'
  try {
    const meta = await apiFetch<{ root?: string | null } | null>('/api/files')
    if (meta && typeof meta.root === 'string' && meta.root) root = meta.root
  } catch {
    // Meta unreadable — the `~` fallback still works unlocked; a locked root
    // will 403 the upload and the chip surfaces it.
  }
  rootCache = { host: c.host, root }
  log('info', 'media', `managed root: ${root}`)
  return root
}

// ── Upload ─────────────────────────────────────────────────────────────────

function randTag(): string {
  return Math.random().toString(36).slice(2, 6)
}

/**
 * Upload one local file to `<root>/relay-uploads/<ts>-<name>` and return the
 * ABSOLUTE gateway path the server wrote (that exact string is what the
 * attach RPCs receive). Falls back to the legacy JSON data-URL endpoint when
 * the gateway predates upload-stream.
 */
export async function uploadToGateway(uri: string, name: string, mime?: string): Promise<string> {
  const c = connConfig.get()
  if (!c) throw new Error('Not connected')
  const root = await resolveManagedRoot()
  const safeName = sanitizeBasename(name)
  const remotePath = `${root}/relay-uploads/${Date.now()}_${randTag()}-${safeName}`
  const mimeType = mime ?? mimeForPath(remotePath)
  // BUG-011: uploadAsync has no deadline of its own — a stalled upload hung
  // sendPrompt forever, holding the session's send lock (every later send to
  // that chat silently vanished into the outbox until app restart). Race the
  // upload against a size-derived deadline, like the JSON fallback below.
  const info = await FileSystem.getInfoAsync(uri)
  const size = info.exists && typeof info.size === 'number' ? info.size : 0
  const deadlineMs = uploadTimeoutMs(size * 2, ATTACH_RATE_KBPS)
  let timerId: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`Upload timed out after ${Math.round(deadlineMs / 1000)}s — check the connection and retry`)),
      deadlineMs,
    )
  })
  let res: FileSystem.FileSystemUploadResult
  try {
    res = await Promise.race([
      FileSystem.uploadAsync(`${httpBase(c)}/api/files/upload-stream`, uri, {
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType,
        parameters: { path: remotePath },
        headers: { 'X-Hermes-Session-Token': c.token },
      }),
      deadline,
    ])
  } finally {
    if (timerId) clearTimeout(timerId)
  }
  if (res.status === 404) {
    // Older deployed gateway: upload-stream doesn't exist → JSON endpoint.
    return uploadViaJsonFallback(c, uri, remotePath, mimeType)
  }
  if (res.status !== 200) throw new Error(`Upload failed (HTTP ${res.status})`)
  let body: { path?: string } = {}
  try { body = JSON.parse(res.body) as { path?: string } } catch { /* handled below */ }
  if (!body.path) throw new Error('Upload returned no path')
  return body.path
}

/** files.py /api/files/upload — JSON data_url. Base64 inflates the body, so
 *  the request timeout is sized from the inflated body, not the raw bytes. */
async function uploadViaJsonFallback(
  c: ConnConfig,
  uri: string,
  remotePath: string,
  mimeType: string,
): Promise<string> {
  const info = await FileSystem.getInfoAsync(uri)
  const size = info.exists && typeof info.size === 'number' ? info.size : 0
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
  const res = await apiFetch<{ path?: string }>('/api/files/upload', {
    method: 'POST',
    body: { path: remotePath, data_url: `data:${mimeType};base64,${b64}` },
    timeoutMs: uploadTimeoutMs(size * 2, ATTACH_RATE_KBPS),
  })
  if (!res.path) throw new Error('Upload returned no path')
  return res.path
}

// ── Image ladder ───────────────────────────────────────────────────────────

const LADDER: Array<{ edge: number; compress: number }> = [
  { edge: 1568, compress: 0.75 },
  { edge: 1024, compress: 0.6 },
]

async function fileSizeOf(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri)
  return info.exists && typeof info.size === 'number' ? info.size : 0
}

/** Long-edge resize (only ONE dimension — the API derives the other to
 *  preserve ratio), always encoded from the ORIGINAL file, saved as JPEG. */
async function encodeRung(
  sourceUri: string,
  rung: { edge: number; compress: number },
  dims: { width: number; height: number } | null,
): Promise<{ uri: string; size: number; width: number; height: number }> {
  const ctx = ImageManipulator.manipulate(sourceUri)
  if (dims && Math.max(dims.width, dims.height) > rung.edge) {
    if (dims.width >= dims.height) ctx.resize({ width: rung.edge })
    else ctx.resize({ height: rung.edge })
  }
  const ref = await ctx.renderAsync()
  const out = await ref.saveAsync({ compress: rung.compress, format: SaveFormat.JPEG })
  return { uri: out.uri, size: await fileSizeOf(out.uri), width: ref.width, height: ref.height }
}

/**
 * JPEG ladder for picked images: 1568 px @ q0.75, then 1024 px @ q0.6 if the
 * first rung exceeds `maxBytes` (the 1.8 MB auto-approve budget). A
 * manipulation failure or an over-budget second rung THROWS — we never send
 * the raw original (a .heic would be rejected by the gateway's allowlist).
 */
export async function prepareImageForUpload(
  uri: string,
  opts?: { maxBytes?: number; width?: number; height?: number },
): Promise<{ uri: string; width: number; height: number }> {
  const maxBytes = opts?.maxBytes ?? ATTACH_AUTO_APPROVE_BYTES
  let dims: { width: number; height: number } | null =
    opts?.width && opts?.height ? { width: opts.width, height: opts.height } : null
  let lastSize = 0
  try {
    for (const rung of LADDER) {
      const out = await encodeRung(uri, rung, dims)
      // The rendered ref's dims: original dims on the first rung, the
      // long-edge-capped dims afterwards — exactly what rung 2 needs.
      dims = { width: out.width, height: out.height }
      lastSize = out.size
      if (out.size <= maxBytes) return { uri: out.uri, width: out.width, height: out.height }
    }
  } catch (err) {
    throw new Error(`Image could not be prepared: ${err instanceof Error ? err.message : String(err)}`)
  }
  throw new Error(`Image too large to send (${Math.round(lastSize / 1000)} kB after downscaling)`)
}

// ── Attach RPCs ────────────────────────────────────────────────────────────

function rpcError(err: unknown): Error {
  // -32601 = the gateway predates the attachment methods (§6 degrade).
  if (err instanceof JsonRpcGatewayError && err.code === -32601) {
    return new Error('This gateway does not support attachments — update the Mochi server')
  }
  return err instanceof Error ? err : new Error(String(err))
}

/** image.attach — queues the image into the session for the next turn. */
async function attachImage(sessionId: string, path: string): Promise<void> {
  try {
    await rpc('image.attach', { session_id: sessionId, path })
  } catch (err) {
    throw rpcError(err)
  }
}

/** file.attach — returns the `@file:` ref_text the prompt text must carry. */
async function attachFile(sessionId: string, name: string, path: string): Promise<string> {
  try {
    const r = await rpc<{ ref_text?: string }>('file.attach', { session_id: sessionId, name, path })
    return r?.ref_text ?? ''
  } catch (err) {
    throw rpcError(err)
  }
}

/** Best-effort image.detach — failure paths only; never throws. */
export async function detachImages(sessionId: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await rpc('image.detach', { session_id: sessionId, path })
    } catch (err) {
      log('warn', 'media', `image.detach failed (${path}): ${String(err)}`)
    }
  }
}

// ── Orchestration ──────────────────────────────────────────────────────────

const isImageAttachment = (att: PendingAttachment): boolean =>
  att.kind === 'image' || mediaKindForPath(att.name) === 'image'

/** The ladder output is JPEG — the remote name must be *.jpg or the gateway's
 *  image allowlist (cli.py _IMAGE_EXTENSIONS) rejects the attach. */
function jpegName(name: string): string {
  const base = sanitizeBasename(name).replace(/\.[^.]+$/, '')
  return `${base || 'image'}.jpg`
}

/**
 * Prepare → upload → attach every attachment, in order, updating chips via
 * `onAttachment` as it goes. On ANY failure the already-attached images are
 * detached and every non-ready chip is marked failed; the error rethrows so
 * the caller can fail the prompt.
 */
export async function processAttachments(args: {
  sessionId: string
  attachments: readonly PendingAttachment[]
  onAttachment?: (id: string, patch: Partial<PendingAttachment>) => void
}): Promise<AttachOutcome> {
  const outcome: AttachOutcome = { refTexts: [], attachedImagePaths: [], pathsById: {} }
  const patch = (id: string, p: Partial<PendingAttachment>) => args.onAttachment?.(id, p)
  try {
    for (const att of args.attachments) {
      let localUri = att.uri
      let name = att.name
      let mime = att.mime
      if (isImageAttachment(att)) {
        patch(att.id, { state: 'preparing' })
        const prepared = await prepareImageForUpload(localUri, { width: att.width, height: att.height })
        localUri = prepared.uri
        name = jpegName(name)
        mime = 'image/jpeg'
      } else {
        // Hard cap for video/audio/files (images are ladder-bounded instead):
        // nothing over it reaches the upload. This is the send-time backstop
        // behind the picker's gate — and it keeps the JSON base64 fallback
        // from ever ingesting a huge file into one JS string.
        const bytes = att.size ?? (await fileSizeOf(localUri))
        if (bytes > ATTACH_MAX_BYTES) {
          throw new Error(`${name} is ${formatBytes(bytes)} — attachments are capped at ${formatBytes(ATTACH_MAX_BYTES)}`)
        }
      }
      patch(att.id, { state: 'uploading', name })
      const remotePath = await uploadToGateway(localUri, name, mime)
      outcome.pathsById[att.id] = remotePath
      if (isImageAttachment(att)) {
        await attachImage(args.sessionId, remotePath)
        outcome.attachedImagePaths.push(remotePath)
      } else {
        const refText = await attachFile(args.sessionId, name, remotePath)
        if (refText) outcome.refTexts.push(refText)
      }
      // 'ready' means uploaded AND attached — a failed attempt leaves the
      // chip 'failed', never half-done.
      patch(att.id, { state: 'ready', path: remotePath, name })
    }
    return outcome
  } catch (err) {
    if (outcome.attachedImagePaths.length) {
      await detachImages(args.sessionId, outcome.attachedImagePaths)
    }
    for (const att of args.attachments) {
      if (att.state !== 'ready') {
        patch(att.id, { state: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }
    throw err
  }
}
