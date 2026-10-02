/**
 * Media spine — pure helpers. No react-native / expo imports: scripts/ runs
 * this in plain node (same contract as sendQueue.ts), and the send/receive
 * modules (mediaSend.ts / mediaCache.ts) layer the I/O on top.
 *
 * Backend shapes this encodes (gateway ~/.hermes/hermes-agent, re-read 2026-09):
 *  - Attachment directives `@image:<path>` / `@file:<path>`; prompt_attachments
 *    `_format_ref_value` quotes values containing `[\s()\[\]{}<>"'\`]` with a
 *    backtick / double / single quote (the first one absent from the value),
 *    so quoted directive values must parse too.
 *  - Extension sets: hermes_cli/cli.py `_IMAGE_EXTENSIONS` (images),
 *    hermes_cli/web_routers/files.py `_STREAMABLE_MEDIA_EXTENSIONS` +
 *    `_MEDIA_CONTENT_TYPES` (stream/download routes).
 *  - Unit basis: kB = 1000 bytes everywhere (the 3-8 kB/s link constraint) —
 *    no ×8 and no 1024s in the rate math.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

/** One media block of a message, either role. `text` is always '' — every
 *  consumer that reads `.text` stays safe (see Chat.tsx hasVisibleText). */
export interface MediaSegmentData {
  kind: 'media'
  text: ''
  mediaType: MediaKind
  /** Gateway-absolute path (/api/files/* URLs are built from this). */
  path: string
  name?: string
  size?: number
  mime?: string
  /** Receive side: 'missing' marks a path the gateway can no longer serve
   *  (deleted / policy-blocked) so the bubble renders an error tile. */
  state?: 'ok' | 'missing'
  /** Send side only: the local file while the gateway path doesn't exist yet
   *  (optimistic user bubble before upload completes). Never persisted to the
   *  server and never set on receive-side segments. */
  localUri?: string
}

export function mediaSegment(init: {
  mediaType?: MediaKind
  path: string
  name?: string
  size?: number
  mime?: string
  state?: 'ok' | 'missing'
  localUri?: string
}): MediaSegmentData {
  const inferred = mediaKindForPath(init.path)
  const mediaType: MediaKind = init.mediaType ?? (inferred === 'unknown' ? 'file' : inferred)
  return {
    kind: 'media',
    text: '',
    mediaType,
    path: init.path,
    ...(init.name !== undefined ? { name: init.name } : {}),
    ...(init.size !== undefined ? { size: init.size } : {}),
    ...(init.mime !== undefined ? { mime: init.mime } : {}),
    ...(init.state !== undefined ? { state: init.state } : {}),
    ...(init.localUri !== undefined ? { localUri: init.localUri } : {}),
  }
}

/** Extracted media item before it becomes a segment (extractMedia internals). */
export interface MediaItem {
  mediaType: MediaKind
  path: string
  name: string
}

// ── Directive parsing (@image: / @file:) ───────────────────────────────────

export interface MediaDirectiveMatch {
  directive: '@image' | '@file'
  /** Bare value, quotes stripped. */
  value: string
  /** Char offsets of the WHOLE token (`@image:` + value + closing quote). */
  start: number
  end: number
}

/** Bare value = non-whitespace run; quoted = one of ` ` " ' (matching pair —
 *  the server never picks a quote char the value itself contains). */
const MEDIA_DIRECTIVE_RE = /@(image|file):(`[^`]*`|"[^"]*"|'[^']*'|\S+)/g

/** Find every `@image:` / `@file:` directive in a text. */
export function parseMediaDirectives(text: string): MediaDirectiveMatch[] {
  const out: MediaDirectiveMatch[] = []
  for (const m of text.matchAll(MEDIA_DIRECTIVE_RE)) {
    const raw = m[2] ?? ''
    const quoted = raw.length >= 2 && ((raw.startsWith('`') && raw.endsWith('`')) || (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    const value = quoted ? raw.slice(1, -1) : raw
    if (!value) continue
    out.push({ directive: m[1] === 'image' ? '@image' : '@file', value, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return out
}

// ── Markdown image extraction ──────────────────────────────────────────────

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

export interface MarkdownImageMatch {
  path: string
  /** Alt text when present, else the basename — the bubble's caption. */
  name: string
  start: number
  end: number
}

/** Absolute-path markdown images only: `http(s)://`, `data:` and relative
 *  paths stay in the text (the gateway can only serve its own disk). */
export function extractMarkdownImages(text: string): MarkdownImageMatch[] {
  const out: MarkdownImageMatch[] = []
  for (const m of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const path = m[2] ?? ''
    if (!path || !isGatewayPath(path)) continue
    out.push({ path, name: (m[1] ?? '').trim() || basenameOf(path), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return out
}

function isGatewayPath(path: string): boolean {
  if (/^https?:\/\//i.test(path)) return false
  if (/^data:/i.test(path)) return false
  return path.startsWith('/')
}

// ── Bare gateway paths (the agent pasted a path instead of sending) ────────
//
// Telegram-style surfaces deliver the file; an LLM often just writes the Unix
// path into the reply ("/home/x/relay-uploads/foo.jpg"). Chat clients can
// serve any gateway-disk path via /api/files/download, so a bare absolute
// path with a known media/doc extension becomes a real attachment bubble —
// with guards so prose never turns into media: https:// URLs, relative paths,
// paths inside markdown/directive tokens, and unknown extensions all stay
// text (overlaps are dropped later by splitMediaFromText's cursor check).

const BARE_PATH_TOKEN_RE = /\/[^\s`"'<>()[\]{}]+/g
/** Sentence punctuation riding on the end of a path ("/tmp/a.png."). */
const BARE_PATH_TRAILING = /[.,;:!?]+$/

export interface BarePathMatch {
  mediaType: MediaKind
  path: string
  name: string
  start: number
  end: number
}

export function extractBarePaths(text: string): BarePathMatch[] {
  const out: BarePathMatch[] = []
  for (const m of text.matchAll(BARE_PATH_TOKEN_RE)) {
    const token = (m[0] ?? '').replace(BARE_PATH_TRAILING, '')
    const start = m.index ?? 0
    const end = start + token.length
    if (token.length < 4) continue
    // A gateway path has a directory part ("~/x" aside, "/" alone is prose):
    // skip "/a.jpg" at the root, and anything whose preceding char folds it
    // into a larger token (https: , foo/bar, another slash).
    if (token.indexOf('/', 1) < 0) continue
    const prev = start > 0 ? text[start - 1] ?? '' : ''
    if (/[\w:/.@~]/.test(prev)) continue
    if (!BARE_PATH_EXTS.has(extOf(token))) continue
    out.push({ mediaType: mediaKindForPath(token) as MediaKind, path: token, name: basenameOf(token), start, end })
  }
  return out
}

// ── Inline data-URL images (native-vision history contract) ────────────────
//
// For vision-capable models the gateway persists an attached image BOTH ways:
// `@image:<path>` in the text part AND the raw `data:image/…;base64,…` URL as
// its own content part. session.resume's `_coerce_message_text` keeps that URL
// inline "so the desktop's extractEmbeddedImages and the resume payload agree"
// (tui_gateway/session_history.py) — so the receiver must scan for it too, or
// every resume paints a wall of truncated base64 into the user's bubble.

const DATA_IMAGE_PREFIX = 'data:image/'
const BASE64_MARKER = ';base64,'
/** Mirrors the desktop's MIN_EMBEDDED_IMAGE_BASE64_LENGTH: shorter runs stay
 *  in the text — a message quoting a tiny data URL is prose, not media. */
const MIN_INLINE_BASE64_LENGTH = 64

function isImageMimeCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 || code === 45 || code === 46 || code === 95
  )
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 43 || code === 47 || code === 61
  )
}

export interface InlineImageMatch {
  /** The full `data:image/…;base64,…` URL. */
  path: string
  name: string
  start: number
  end: number
}

function inlineImageName(mime: string, index: number): string {
  const sub = mime.slice(DATA_IMAGE_PREFIX.length).split('+')[0]?.split(';')[0] ?? ''
  const ext = sub === 'jpeg' ? 'jpg' : sub || 'img'
  return `embedded-${index + 1}.${ext}`
}

/** True when a segment path is an inline data: URL — rendered straight from
 *  the string (no gateway fetch, no relay-media cache key, never persisted). */
export function isDataUrlPath(path: string | undefined): path is string {
  return !!path && /^data:/i.test(path)
}

/** Every bare `data:image/<mime>;base64,<run>` in a text, in document order
 *  (the mobile twin of the desktop's readDataImageUrl scan). */
export function extractInlineImages(text: string): InlineImageMatch[] {
  const out: InlineImageMatch[] = []
  if (!text.includes(DATA_IMAGE_PREFIX)) return out
  let search = 0
  for (;;) {
    const start = text.indexOf(DATA_IMAGE_PREFIX, search)
    if (start < 0) break
    let cursor = start + DATA_IMAGE_PREFIX.length
    while (cursor < text.length && isImageMimeCode(text.charCodeAt(cursor))) cursor++
    const mimeEnd = cursor
    if (mimeEnd === start + DATA_IMAGE_PREFIX.length || !text.startsWith(BASE64_MARKER, cursor)) {
      search = start + DATA_IMAGE_PREFIX.length
      continue
    }
    cursor += BASE64_MARKER.length
    const b64Start = cursor
    while (cursor < text.length && isBase64Code(text.charCodeAt(cursor))) cursor++
    if (cursor - b64Start < MIN_INLINE_BASE64_LENGTH) {
      search = cursor
      continue
    }
    out.push({
      path: text.slice(start, cursor),
      name: inlineImageName(text.slice(start, mimeEnd), out.length),
      start,
      end: cursor,
    })
    search = cursor
  }
  return out
}

// ── Extraction: text → [text?][media…] ─────────────────────────────────────

interface SplitText {
  /** Text with every directive/markdown-image token removed. */
  text: string
  media: MediaItem[]
}

/** Strip directives + markdown images + inline data-URL images from one
 *  text, returning the media in document order. Quoted values (`` ` ``,
 *  `"`,`'``) are stripped whole, so extraction never corrupts the surrounding
 *  words. */
export function splitMediaFromText(text: string): SplitText {
  /** One token range. `item: null` = strip from the text without becoming a
   *  media segment (a paired inline data URL — the @image: directive wins). */
  type Range = { start: number; end: number; item: MediaItem | null }
  const ranges: Range[] = []
  const imageDirectiveCount = { n: 0 }
  for (const d of parseMediaDirectives(text)) {
    ranges.push({
      start: d.start,
      end: d.end,
      item: { mediaType: d.directive === '@image' ? 'image' : 'file', path: d.value, name: basenameOf(d.value) },
    })
    if (d.directive === '@image') imageDirectiveCount.n++
  }
  for (const im of extractMarkdownImages(text)) {
    ranges.push({ start: im.start, end: im.end, item: { mediaType: 'image', path: im.path, name: im.name } })
  }
  // Inline data URLs: a persisted user turn carries the `@image:<path>`
  // directive AND the raw URL for the SAME image (refs and content parts are
  // built from the same ordered list — refs first, URLs after). Pair them
  // from the end and strip the paired URLs without segments: the directive's
  // gateway path is the durable, cache-sized render source (a data-URL
  // segment would keep megabytes of base64 alive per message and never
  // survive a restart). Unpaired URLs (no matching directive) become segments.
  const inline = extractInlineImages(text)
  const pairedCount = Math.min(imageDirectiveCount.n, inline.length)
  for (let i = 0; i < inline.length; i++) {
    const h = inline[i]
    ranges.push({
      start: h.start,
      end: h.end,
      item: i < inline.length - pairedCount ? { mediaType: 'image', path: h.path, name: h.name } : null,
    })
  }
  // Bare gateway paths LAST: a path token inside a markdown image or after a
  // directive starts later, so the cursor check below lets the structured
  // form win and the bare scan only claims free-standing paths.
  for (const bp of extractBarePaths(text)) {
    ranges.push({ start: bp.start, end: bp.end, item: { mediaType: bp.mediaType, path: bp.path, name: bp.name } })
  }
  if (!ranges.length) return { text, media: [] }
  ranges.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  const media: MediaItem[] = []
  for (const r of ranges) {
    if (r.start < cursor) continue // a directive value swallowed a markdown token — already consumed
    out += text.slice(cursor, r.start)
    cursor = r.end
    if (r.item) media.push(r.item)
  }
  out += text.slice(cursor)
  return { text: out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim(), media }
}

/** Text with media markers removed (notifications/copy/attention bodies). */
export function stripMediaFromText(text: string): string {
  return splitMediaFromText(text).text
}

/**
 * Split text segments in place: each becomes `[text?][media…]` — media lands
 * directly after its source segment and survives supersede. Idempotent
 * (markers are stripped, so a second pass is a no-op). Non-text segments and
 * media segments pass through untouched.
 */
export function extractMedia<T extends { kind: string; text: string }>(segments: readonly T[]): Array<T | MediaSegmentData> {
  const out: Array<T | MediaSegmentData> = []
  for (const seg of segments) {
    if (seg.kind !== 'text' || !seg.text) {
      out.push(seg)
      continue
    }
    const { text, media } = splitMediaFromText(seg.text)
    if (!media.length) {
      out.push(seg)
      continue
    }
    const head = { ...seg, text }
    if (text) out.push(head as T)
    for (const item of media) {
      out.push(mediaSegment({ mediaType: item.mediaType, path: item.path, name: item.name }))
    }
  }
  return out
}

/** Joined text of the non-media segments — the `m.text` contract (copy,
 *  speak, search see "the words", never the markers). */
export function joinedTextOf(segments: ReadonlyArray<{ kind: string; text: string }>): string {
  return segments
    .filter((seg) => seg.kind === 'text')
    .map((seg) => seg.text)
    .join('')
}

// ── Classification ─────────────────────────────────────────────────────────

/** cli.py `_IMAGE_EXTENSIONS` (image.attach's allowlist) ∪ files.py
 *  `_MEDIA_CONTENT_TYPES` — the extensions the gateway will treat as images. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.ico'])
/** files.py `_STREAMABLE_MEDIA_EXTENSIONS`, split by player kind. */
const VIDEO_EXTS = new Set(['.avi', '.mkv', '.mov', '.mp4', '.webm'])
const AUDIO_EXTS = new Set(['.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav'])
/** Extensions worth rendering from a bare path mention (never unknown exts). */
const BARE_PATH_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, '.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.csv', '.xls', '.xlsx', '.zip', '.gz', '.tar', '.json', '.log'])

export function extOf(path: string): string {
  const name = basenameOf(path.split('?')[0] ?? '')
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** image / video / audio / file, or 'unknown' (still attachable — file.attach
 *  takes any path; FileCard renders the generic icon for it). */
export function mediaKindForPath(path: string): MediaKind | 'unknown' {
  const ext = extOf(path)
  if (!ext) return 'unknown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return 'file'
}

export function mimeForPath(path: string): string {
  switch (extOf(path)) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.svg': return 'image/svg+xml'
    case '.bmp': return 'image/bmp'
    case '.ico': return 'image/x-icon'
    case '.tiff':
    case '.tif': return 'image/tiff'
    case '.avi': return 'video/x-msvideo'
    case '.mkv': return 'video/x-matroska'
    case '.mov': return 'video/quicktime'
    case '.mp4': return 'video/mp4'
    case '.webm': return 'video/webm'
    case '.flac': return 'audio/flac'
    case '.m4a': return 'audio/mp4'
    case '.mp3': return 'audio/mpeg'
    case '.ogg': return 'audio/ogg'
    case '.opus': return 'audio/ogg'
    case '.wav': return 'audio/wav'
    case '.pdf': return 'application/pdf'
    case '.zip': return 'application/zip'
    case '.txt': return 'text/plain'
    case '.md': return 'text/markdown'
    case '.csv': return 'text/csv'
    case '.json': return 'application/json'
    default: return 'application/octet-stream'
  }
}

// ── Names / cache keys ─────────────────────────────────────────────────────

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Path-safe basename: separators and `..` components collapsed to the final
 *  segment, control characters removed, never empty. */
export function sanitizeBasename(raw: string): string {
  const base = basenameOf(String(raw ?? ''))
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!cleaned || /^[.]+$/.test(cleaned)) return 'attachment'
  return cleaned
}

/** FNV-1a, hex, deterministic across runs and devices (no crypto, no deps). */
function hash8(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Relay-media cache filename: `<sanitized-name>-<hash8(path)>` — readable,
 *  collision-free for two files with the same basename, stable across
 *  restarts (the cache has no index; the name IS the key). */
export function cacheKeyFor(path: string): string {
  return `${sanitizeBasename(basenameOf(path))}-${hash8(path)}`
}

// ── Budgets (kB = 1000 bytes) ──────────────────────────────────────────────

/** Auto-approve ceiling for one attachment: rate × budget. (3 kB/s, 10 min)
 *  → 1.8 MB — what we send without asking on the worst link. */
export function maxAttachBytesFor(rateKbps: number, budgetS: number): number {
  if (!(rateKbps > 0) || !(budgetS > 0)) return 0
  return Math.floor(rateKbps * 1000 * budgetS)
}

/** Seconds to push `bytes` at the given rate (no ×8 — kB/s IS bytes/s here). */
export function estSecondsFor(bytes: number, rateKbps: number): number {
  if (!(rateKbps > 0)) return Infinity
  return bytes / (rateKbps * 1000)
}

/** HTTP timeout for an upload so a slow link isn't cut mid-flight:
 *  estimate × 1.5 headroom, 2 min floor. */
export function uploadTimeoutMs(bytes: number, rateKbps: number): number {
  const est = estSecondsFor(bytes, rateKbps)
  if (!Number.isFinite(est)) return 120_000
  return Math.max(120_000, Math.ceil(est * 1.5) * 1000)
}

/** Attach budgets (kB = 1000 bytes). ≤ ATTACH_AUTO_APPROVE_BYTES sends
 *  without asking (rate × budget); non-image attachments over the hard cap
 *  ATTACH_MAX_BYTES are rejected at pick time (and re-checked at send time)
 *  — images instead ride the JPEG ladder down to the auto-approve budget. */
export const ATTACH_RATE_KBPS = 3
export const ATTACH_AUTO_APPROVE_S = 600
export const ATTACH_AUTO_APPROVE_BYTES = maxAttachBytesFor(ATTACH_RATE_KBPS, ATTACH_AUTO_APPROVE_S)
export const ATTACH_MAX_BYTES = 8_000_000

/** Attachments per message (the composer enforces this). */
export const MAX_ATTACHMENTS = 4

/** Images at or under this fetch immediately; bigger ones render a tap-to-fetch tile. */
export const AUTO_DOWNLOAD_MAX_BYTES = 512_000

export function shouldAutoDownload(bytes: number | undefined | null): boolean {
  if (bytes == null || !Number.isFinite(bytes)) return false
  return bytes <= AUTO_DOWNLOAD_MAX_BYTES
}

/** "1.8 MB" / "512 kB" / "230 B" — kB=1000 basis, matching the caps above. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1000) return `${Math.round(bytes)} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

// ── UI classification / geometry (pure — components + tests share these) ───

/** m:ss (h:mm:ss past an hour) for audio/video players and chip timers. */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  const ss = String(r).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * Image-bubble box for an image of the given pixel dims, longest edge capped
 * at maxEdge (aspect-fit; never upscales a small image). null when the dims
 * are unknown — the bubble falls back to a square until expo-image's onLoad
 * reports the real size.
 */
export function fitWithin(
  maxEdge: number,
  width?: number | null,
  height?: number | null,
): { width: number; height: number } | null {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** FileCard icon per extension (files.py-style grouping); unknown ext falls
 *  through to the generic attachment icon — the fallback row. The names are
 *  Ionicons glyph names; components cast, tests assert strings. */
const FILE_ICONS: Record<string, string> = {
  pdf: 'document-text-outline',
  doc: 'document-text-outline',
  docx: 'document-text-outline',
  txt: 'document-text-outline',
  md: 'document-text-outline',
  rtf: 'document-text-outline',
  csv: 'grid-outline',
  xls: 'grid-outline',
  xlsx: 'grid-outline',
  zip: 'file-tray-full-outline',
  gz: 'file-tray-full-outline',
  tar: 'file-tray-full-outline',
  json: 'code-slash-outline',
  py: 'code-slash-outline',
  ts: 'code-slash-outline',
  tsx: 'code-slash-outline',
  js: 'code-slash-outline',
  sh: 'terminal-outline',
  log: 'terminal-outline',
}

export function fileIconForPath(path: string): string {
  return FILE_ICONS[extOf(path).replace('.', '')] ?? 'document-attach-outline'
}

// ── Prompt text budget ─────────────────────────────────────────────────────

export const PROMPT_TEXT_MAX = 8000

/**
 * The user's own words, capped at 8000 − Σ ref_text lengths — the gateway
 * slices prompt text at 8000 chars, so the refs appended AFTER the user text
 * must fit under the same ceiling (refs themselves are never truncated).
 */
export function refTextBudget(text: string, refs: readonly string[]): string {
  const spent = refs.reduce((n, r) => n + r.length, 0)
  return text.slice(0, Math.max(0, PROMPT_TEXT_MAX - spent))
}

/** Final prompt text: user words (budgeted) + `@file:` refs appended last. */
export function appendRefText(text: string, refs: readonly string[]): string {
  if (!refs.length) return text
  const head = refTextBudget(text, refs)
  return head ? `${head}\n${refs.join('\n')}` : refs.join('\n')
}

// ── Cold-start cache prune plan ────────────────────────────────────────────

export interface CacheFileInfo {
  path: string
  mtimeMs: number
  size: number
}

/** Age out (> maxAgeMs), then trim oldest-first while the cache exceeds
 *  maxBytes. Returns the paths to delete, oldest-last overall. */
export function planCachePrune(
  files: readonly CacheFileInfo[],
  opts: { maxAgeMs: number; maxBytes: number; now?: number },
): string[] {
  const now = opts.now ?? Date.now()
  const doomed: string[] = []
  const keep: CacheFileInfo[] = []
  for (const f of files) {
    if (now - f.mtimeMs > opts.maxAgeMs) doomed.push(f.path)
    else keep.push(f)
  }
  let total = keep.reduce((n, f) => n + f.size, 0)
  const oldestFirst = [...keep].sort((a, b) => a.mtimeMs - b.mtimeMs)
  while (total > opts.maxBytes && oldestFirst.length) {
    const f = oldestFirst.shift()!
    doomed.push(f.path)
    total -= f.size
  }
  return doomed
}
