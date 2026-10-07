import { atom } from 'nanostores'
import { log } from './log'
import { MAX_ATTACHMENTS } from './media'

/**
 * "Ask Moch" share-in inbox — the receiving side of the OS share target
 * (AndroidManifest MainActivity ACTION_SEND filters; native relay in
 * ShareInModule.kt, fed by MainActivity.onCreate/onNewIntent).
 *
 * Flow: native `ShareIn.take()` hands JS one parsed share (text + copied
 * files) and clears the relay in the same breath → normalizeSharedPayload →
 * shareInInbox atom → the root layout routes to the chat tab → chat.tsx
 * applies text into the composer draft and files as attachment chips (never
 * auto-sends — the user taps Send, ChatGPT-style). Consumption is ack-based:
 * whoever drains the inbox calls ackShareIn().
 *
 * Same contract as drafts.ts: no react-native imports at module scope — the
 * native module and the event emitter load lazily behind accessors, so
 * scripts/test-sharein.ts runs this in plain node with fakes injected.
 */

export const SHAREIN_EVENT = 'MochShareIn'
/** Parity with the composer's draft/send text cap (sendQueue MAX_TEXT). */
export const SHARED_TEXT_MAX = 8000
export const SHARED_SUBJECT_MAX = 300

export interface SharedFile {
  /** Local file:// uri — the native relay already copied the bytes into
   *  our cacheDir (a content:// uri dies with the sharing app). */
  uri: string
  name: string
  size?: number
  mime?: string
}

export interface SharedPayload {
  text: string
  subject: string
  files: SharedFile[]
  /** Files the native relay rejected (over the 8 MB share cap). Surfaced as
   *  an alert by the composer; never silently dropped. */
  skipped: number
  at: number
}

/** The one share awaiting pickup by the chat composer; null when none. */
export const shareInInbox = atom<SharedPayload | null>(null)

/**
 * Coerce a raw native payload into a usable one, or null when it carries
 * nothing sendable. Pure — every defensive trim lives here so the composer
 * can trust what it gets.
 */
export function normalizeSharedPayload(raw: SharedPayload | null | undefined): SharedPayload | null {
  if (!raw) return null
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, SHARED_TEXT_MAX) : ''
  const subject =
    typeof raw.subject === 'string' ? raw.subject.trim().slice(0, SHARED_SUBJECT_MAX) : ''
  const files = Array.isArray(raw.files)
    ? raw.files
        .filter((f): f is SharedFile => !!f && typeof f.uri === 'string' && f.uri.length > 0)
        .slice(0, MAX_ATTACHMENTS)
    : []
  const skipped = Math.max(0, Math.trunc(Number(raw.skipped) || 0))
  if (!text && !subject && files.length === 0) return null
  return {
    text,
    subject,
    files,
    skipped,
    at: Number(raw.at) || Date.now(),
  }
}

/**
 * Merge a share's text into the current composer draft. The subject (page
 * title etc.) is only a fallback: when the sharing app put the useful bit in
 * EXTRA_TEXT, appending both would duplicate it. Pure.
 */
export function applySharedToDraft(existing: string, shared: SharedPayload): string {
  const base = shared.text || shared.subject
  if (!base) return existing
  const cur = existing ?? ''
  return cur ? `${cur}\n\n${base}` : base
}

/** Mark the inbox item consumed. */
export function ackShareIn(): void {
  shareInInbox.set(null)
}

// ── Native surface (lazy; injectable for tests) ────────────────────────────

type NativeShareIn = { take(): Promise<SharedPayload | null> }
type EmitterLike = { addListener(name: string, cb: () => void): { remove(): void } }

let nativeOverride: NativeShareIn | null = null
let emitterOverride: EmitterLike | null = null
/** Scripts inject fakes here; real apps never call this. */
export function _useNativeForTests(n: NativeShareIn | null, e?: EmitterLike | null): void {
  nativeOverride = n
  emitterOverride = e ?? null
}

async function nativeModule(): Promise<NativeShareIn | null> {
  if (nativeOverride) return nativeOverride
  try {
    const rn = (await import('react-native')) as unknown as {
      NativeModules?: { ShareIn?: NativeShareIn }
    }
    return rn.NativeModules?.ShareIn ?? null
  } catch {
    return null
  }
}

async function emitter(): Promise<EmitterLike | null> {
  if (emitterOverride) return emitterOverride
  try {
    const rn = (await import('react-native')) as unknown as {
      DeviceEventEmitter?: EmitterLike
    }
    return rn.DeviceEventEmitter ?? null
  } catch {
    return null
  }
}

/**
 * Pull one share from the native relay into the inbox. True when something
 * landed. Safe to call speculatively (returns fast when the relay is empty).
 */
export async function pullSharedIntoInbox(): Promise<boolean> {
  try {
    const n = await nativeModule()
    if (!n) return false
    const shared = normalizeSharedPayload(await n.take())
    if (!shared) return false
    shareInInbox.set(shared)
    return true
  } catch (err) {
    log('warn', 'shareIn', `pull failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

let onShareCb: (() => void) | null = null
let deliverScheduled = false

/** One pull + route, coalesced: an event arriving while a pull is already in
 *  flight must not stack a second one (the second take() would race the
 *  first for the same payload). */
export function deliverSharedNow(): void {
  if (deliverScheduled) return
  deliverScheduled = true
  void (async () => {
    try {
      if (await pullSharedIntoInbox()) onShareCb?.()
    } finally {
      deliverScheduled = false
    }
  })()
}

/**
 * Boot the share-in pipeline (root layout, once): cold-start pull (the relay
 * may hold a share captured in MainActivity.onCreate), then the MochShareIn
 * nudge subscription. Returns a cleanup for the subscription. Foreground
 * re-pulls are the layout's AppState handler's job — call deliverSharedNow()
 * there (a share received while the process was backgrounded may have missed
 * the event entirely).
 */
export function initShareIn(onShare: () => void): () => void {
  onShareCb = onShare
  let off: (() => void) | null = null
  deliverSharedNow()
  void (async () => {
    const e = await emitter()
    if (!e) return
    const sub = e.addListener(SHAREIN_EVENT, () => deliverSharedNow())
    off = () => sub.remove()
  })()
  return () => {
    off?.()
    if (onShareCb === onShare) onShareCb = null
  }
}
