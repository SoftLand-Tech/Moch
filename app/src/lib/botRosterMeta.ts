/**
 * Pure helpers for the drawer's Bots roster (UI-1, slice D).
 *
 * Product model (verified in the Hermes backend + desktop): a bot is ONE
 * profile with ONE persistent conversation titled exactly `Bot Chat`
 * (`lib/botChat.ts`). So a roster row is a PROFILE, not a chat: the drawer in
 * Bots mode shows one row per bot and never a per-bot chat list. The row's
 * subtitle is the bot's newest activity (its canonical Bot Chat when it has
 * one), and the row's tap target is that canonical chat.
 *
 * Everything here is pure: no react-native / expo / AsyncStorage imports, so
 * `scripts/` can unit-test every branch in plain node (same contract as
 * `lib/attention.ts`, whose `rowStatus` this module reuses rather than
 * re-deriving a second dot policy).
 *
 * The wire shape is read defensively on purpose. `profiles.list` answers
 * `last_session` / `worker_session` / `canonical_session` in snake_case, and
 * the app's `FleetProfile` mirrors only the canonical one in camelCase today.
 * Both spellings are accepted here, and `null`/absent degrades to "no preview"
 * instead of a blank row — the roster must render on an older gateway.
 */
import { rowStatus, type AttentionRecord, type RowStatus } from './attention'

/** The profile that IS the assistant (not a fleet bot). */
export const DEFAULT_PROFILE = 'default'
/** How the default profile reads in the roster (a name, not translatable copy). */
export const DEFAULT_BOT_LABEL = 'Moch'
/** A row preview is one line of conversation; past this it is clipped. */
export const PREVIEW_MAX = 80

/** One session summary as the roster needs it (canonical / newest / worker). */
export interface RosterSession {
  id: string
  title: string
  preview: string
  /** Wall-clock ms of the session's last activity (0 = unknown). */
  lastActiveTs: number
}

/** One drawer row: a bot profile, flattened for rendering. */
export interface RosterRow {
  /**
   * What a tap hands back to the shell. `''` means the DEFAULT agent — there
   * is no `Bot Chat` on `default`, so the shell starts an ordinary chat
   * instead (same key desktop's rail uses for its Mochi row).
   */
  key: string
  /** The real profile name (never `''`), used for RPCs and status lookups. */
  profile: string
  /** Display name — `Moch` for the default profile. */
  name: string
  description: string
  isDefault: boolean
  /** True when the roster reports a canonical `Bot Chat` for this profile. */
  canonical: boolean
  /** The canonical chat's stored id (the fail-closed probe's key), if any. */
  canonicalId?: string
  /** A frozen bot is paused: it can ask, but it is never "working". */
  frozen: boolean
  /** Newest human-facing conversation (drives the preview). */
  lastSession: RosterSession | null
  /** Newest worker (kanban/tool) session — fresh means the bot is working. */
  worker: RosterSession | null
  /** Latest activity across canonical + last + worker (0 = unknown). */
  lastActiveTs: number
  /** One-line, prefix-stripped, ≤{@link PREVIEW_MAX} chars. Empty = no text. */
  preview: string
}

/**
 * The subset of a `profiles.list` row this module reads. Every field is
 * optional/unknown so a raw wire row AND the app's typed `FleetProfile` are
 * both assignable.
 */
export interface RosterProfileLike {
  name?: unknown
  description?: unknown
  is_default?: unknown
  isDefault?: unknown
  frozen?: unknown
  canonical_session?: unknown
  canonicalSession?: unknown
  last_session?: unknown
  lastSession?: unknown
  worker_session?: unknown
  workerSession?: unknown
}

interface SessionLike {
  id?: unknown
  title?: unknown
  root_title?: unknown
  preview?: unknown
  started_at?: unknown
  last_active?: unknown
}

/** `started_at` / `last_active` are fractional SECONDS; be unit-defensive. */
function toMs(ts: unknown): number {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 0
  if (ts > 1e10) return ts // already milliseconds on some backends
  return ts * 1000
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function obj(v: unknown): SessionLike | null {
  return v && typeof v === 'object' ? (v as SessionLike) : null
}

/** A session summary, or null when there is no usable id (nothing to open). */
function sessionOf(raw: unknown): RosterSession | null {
  const s = obj(raw)
  if (!s) return null
  const id = str(s.id)
  if (!id) return null
  return {
    id,
    title: str(s.title) || str(s.root_title),
    preview: str(s.preview),
    // The canonical row reports `last_active` (the live tip's heartbeat);
    // the last-session row reports it too, falling back to `started_at`.
    lastActiveTs: toMs(s.last_active) || toMs(s.started_at),
  }
}

/**
 * Strip the fleet's DM envelope (`Message from 🤖 dex (@dex): …`) and flatten
 * to ONE line of at most {@link PREVIEW_MAX} chars.
 *
 * The envelope is added by `bot_mode_dm` on the server, so a Bot Chat's newest
 * message can arrive wearing it; showing it in a drawer row would waste the
 * whole line on attribution the row already carries (the bot's name/avatar).
 */
export function botPreview(
  bot: string | { preview?: string | null } | null | undefined,
): string {
  const raw = typeof bot === 'string' ? bot : typeof bot?.preview === 'string' ? bot.preview : ''
  if (!raw) return ''
  // `Message from <name> (@handle): ` — everything up to the FIRST colon.
  const stripped = raw.replace(/^\s*message from\b[^:\n]{0,160}:\s*/i, '')
  const oneLine = stripped.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= PREVIEW_MAX) return oneLine
  return `${oneLine.slice(0, PREVIEW_MAX - 1).trimEnd()}…`
}

/**
 * Flatten `profiles.list` into drawer rows: the default profile FIRST (as
 * `Moch`), then the bots by latest activity, then by name.
 *
 * Bots with no session yet still get a row — a fresh bot's only entry point is
 * its roster row, so dropping it would make the bot unreachable.
 */
export function rosterRows(
  profiles: readonly RosterProfileLike[] | null | undefined,
): RosterRow[] {
  const rows: RosterRow[] = []
  for (const p of profiles ?? []) {
    const profile = str(p?.name)
    if (!profile) continue
    const isDefault = profile === DEFAULT_PROFILE || p?.is_default === true || p?.isDefault === true
    const canonical = sessionOf(p?.canonicalSession ?? p?.canonical_session)
    const lastSession = sessionOf(p?.lastSession ?? p?.last_session)
    const worker = sessionOf(p?.workerSession ?? p?.worker_session)
    const lastActiveTs = Math.max(
      canonical?.lastActiveTs ?? 0,
      lastSession?.lastActiveTs ?? 0,
      worker?.lastActiveTs ?? 0,
    )
    rows.push({
      key: isDefault ? '' : profile,
      profile,
      name: isDefault ? DEFAULT_BOT_LABEL : profile,
      description: str(p?.description),
      isDefault,
      canonical: !!canonical,
      ...(canonical ? { canonicalId: canonical.id } : {}),
      frozen: p?.frozen === true,
      lastSession,
      worker,
      lastActiveTs,
      // The canonical chat is the forever-chat: its preview is what the bot
      // last said THERE, which is the row's meaning. Falling back to any newer
      // conversation keeps a just-created side chat from hiding the row's text.
      preview: botPreview(lastSession?.preview || canonical?.preview || ''),
    })
  }
  rows.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    if (a.lastActiveTs !== b.lastActiveTs) return b.lastActiveTs - a.lastActiveTs
    return a.name.localeCompare(b.name)
  })
  return rows
}

/**
 * The row's status dot. Reuses the drawer's single dot policy (`rowStatus`):
 * an attention state (`input` / `done` / `error`) outranks the busy pulse, and
 * an unanswered question outranks everything.
 *
 * `busy` / `pending` are per-BOT booleans: any conversation on that profile
 * streaming, or blocking on a question. A frozen bot is never reported busy
 * (its turns are held), but a question it already asked still shows.
 */
export function botRowStatus(
  bot: RosterRow | { frozen?: boolean } | null | undefined,
  busy?: boolean,
  attention?: AttentionRecord | null,
  pending?: boolean,
): RowStatus | undefined {
  return rowStatus(!!busy && !bot?.frozen, attention ?? undefined, !!pending)
}

/**
 * A compact age: `2m`, `1h`, `3d`. Deliberately unit-suffixed numbers and not
 * prose, so the same string reads in EN and AR without a second catalog entry
 * (the row's space is ~40dp). Sub-minute is `<1m`; unknown is `''`.
 */
export function relativeAge(ts?: number | null, now: number = Date.now()): string {
  const ms = toMs(ts)
  if (!ms) return ''
  const delta = now - ms
  if (delta < 60_000) return '<1m'
  const mins = Math.floor(delta / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}

/**
 * Up to two characters for the avatar disc: word initials when the name has
 * two words (`price-watcher` → `PW`), else the first two letters (`Moch` →
 * `Mo`) — the same read as the desktop rail's `name.slice(0, 2)`.
 */
export function botInitials(name: string): string {
  const words = name
    .split(/[\s_-]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const one = words[0] ?? ''
  return (one.slice(0, 2) || '?').toUpperCase()
}

/** Stable 0..3 disc slot for a name (the component maps it onto theme tints). */
export function botTintIndex(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 4
}
