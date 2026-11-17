/**
 * Canonical Bot Chat (UI-1, slice B).
 *
 * A bot is a profile with ONE canonical conversation titled exactly
 * `Bot Chat` — the forever-chat its roster row opens. Hermes itself treats
 * that NAME as the identity: the desktop, `hermes peer dm` and the TUI all
 * resolve it by exact-title lookup, and the session store's title
 * uniqueness allows at most one row per profile. So the phone must never
 * grow a per-bot chat list, and must never mint a second `Bot Chat` just
 * because a lookup failed for a non-absence reason — a duplicate splits the
 * bot's memory in two and the desktop then flip-flops between them.
 *
 * Wire contract (verified in `tui_gateway`):
 *  - `session.list { profile, title, limit, include_hidden }` is the
 *    identity lookup: exact title, windowless (a busy profile's ordinary
 *    listing can push the row out of the window), hidden rows INCLUDED —
 *    canonical chats are born hidden.
 *  - `session.create { profile, title, hidden, follow_profile_config }` is
 *    LAZY: it mints a live session but no DB row until the first prompt.
 *    `session.title` therefore writes the row + the name immediately, so
 *    the second device sees the canonical chat instead of minting its own.
 *  - A title write rejected with "already in use" means another client won
 *    the race: adopt ITS row, never fail the tap and never create again.
 *
 * Plain-node contract: `scripts/test-bot-chat.ts` exercises this module, so
 * `./gateway`, `./fleet` and `./chat` (all RN-scope at import time) are
 * loaded lazily at their call sites and every seam has a test injector —
 * the same pattern as `lib/sessionList.ts`.
 */
import { atom } from 'nanostores'
import { log } from './log'

/** The canonical conversation's title. Identity, not decoration: every
 *  surface resolves the bot's forever-chat by this exact string. */
export const BOT_CHAT_TITLE = 'Bot Chat'

/** One canonical chat as the wire reports it. `storedId` is the durable
 *  registry row (what `session.resume` takes); `resolvedId` is the live
 *  compression tip when the lookup followed a lineage. */
export interface BotChatRef {
  storedId: string
  resolvedId?: string
}

/** Last failure message, for surfaces that render a banner instead of an
 *  alert (the bot screen shows an alert from the thrown error). */
export const botChatError = atom('')

/** Rows fetched by the lookup; the exact-title contract is windowless, so
 *  the limit is only a safety net. */
const LIST_LIMIT = 50
/** Same width the app's own creates use (agent output wrapping). */
const CREATE_COLS = 80

// ── Lazy gateway access (see the plain-node note above) ─────────────────────
type RpcFn = typeof import('./gateway')['rpc']
let rpcOverride: RpcFn | null = null
/** Scripts inject a fake RPC here (offline suites); real apps never do. */
export function _useBotChatRpcForTests(r: RpcFn | null) {
  rpcOverride = r
}

async function botRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  if (rpcOverride) return rpcOverride<T>(method, params)
  const { rpc } = await import('./gateway')
  return rpc<T>(method, params)
}

// ── Roster evidence (fail closed, never mint a duplicate) ───────────────────
type RosterProbe = (profile: string) => boolean | Promise<boolean>
let rosterProbeOverride: RosterProbe | null = null
/** Scripts inject the roster answer here; real apps read `fleet.ts`. */
export function _useBotChatRosterForTests(p: RosterProbe | null) {
  rosterProbeOverride = p
}

/**
 * True only on POSITIVE evidence: the fleet roster carries this profile's
 * `canonical_session` (`profiles.list` reports it). A failed or empty roster
 * read is "no evidence", never a blocker — the roster is a cache, and a cold
 * start must still be able to open a bot chat.
 */
let rosterPrimed = false
async function rosterHasCanonicalChat(profile: string): Promise<boolean> {
  if (rosterProbeOverride) return await rosterProbeOverride(profile)
  try {
    const { fleetProfiles, refreshFleet } = await import('./fleet')
    // A cold start (deep link straight to a bot) has never painted the Fleet
    // screen, so the roster is EMPTY rather than "no canonical chat" — prime
    // it once, best effort, so the probe can actually see the row.
    if (!rosterPrimed && fleetProfiles.get().length === 0) {
      rosterPrimed = true
      await refreshFleet().catch(() => {})
    }
    return fleetProfiles.get().some((p) => p.name === profile && !!p.canonicalSession?.id)
  } catch {
    return false
  }
}

// ── Errors ─────────────────────────────────────────────────────────────────
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Record the failure for the UI and hand the caller the same text. */
function botChatFailure(message: string): Error {
  botChatError.set(message)
  return new Error(message)
}

// ── Wire row → ref ─────────────────────────────────────────────────────────
interface BotChatRow {
  id?: unknown
  resolved_id?: unknown
  title?: unknown
}

/**
 * The row whose TRIMMED title is exactly `Bot Chat`. Exact-title lookup is
 * already exact server-side, but a title lookup can also arrive from an
 * older peer that ignored the filter and returned a plain listing, so the
 * match is re-applied here — never "the first session".
 */
function matchBotChat(rows: BotChatRow[]): BotChatRef | null {
  for (const row of rows) {
    const title = typeof row?.title === 'string' ? row.title.trim() : ''
    if (title !== BOT_CHAT_TITLE) continue
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (!id) continue
    const resolved = typeof row?.resolved_id === 'string' ? row.resolved_id.trim() : ''
    return resolved ? { storedId: id, resolvedId: resolved } : { storedId: id }
  }
  return null
}

/**
 * The raw exact-title lookup. THROWS on a failed RPC — absence must be
 * proven by a successful, empty answer, never inferred from an error (a
 * network blip that read as "not found" is how duplicate canonical chats
 * were born).
 */
async function listBotChatRows(profile: string): Promise<BotChatRow[]> {
  try {
    const res = await botRpc<{ sessions?: BotChatRow[] }>('session.list', {
      profile,
      title: BOT_CHAT_TITLE,
      limit: LIST_LIMIT,
      include_hidden: true,
    })
    return Array.isArray(res?.sessions) ? res.sessions : []
  } catch (err) {
    throw botChatFailure(
      `Could not look up ${profile}'s ${BOT_CHAT_TITLE}: ${errMessage(err)}`,
    )
  }
}

/**
 * Exact-title lookup on the bot's profile. Never mints.
 *
 * Returns `null` only when the gateway says the profile has no canonical
 * chat. A thrown lookup fails closed, and so does an empty answer while the
 * roster already reports a `canonical_session` for this profile (an older
 * gateway that cannot expose hidden rows, or a row retired behind an
 * archive): in both cases minting is forbidden.
 */
export async function findBotChat(profile: string): Promise<BotChatRef | null> {
  const ref = matchBotChat(await listBotChatRows(profile))
  if (ref) return ref
  if (await rosterHasCanonicalChat(profile)) {
    throw botChatFailure(
      `Could not open ${profile}'s ${BOT_CHAT_TITLE} — the roster says it exists but the ` +
        'gateway did not return it. Refresh and try again.',
    )
  }
  return null
}

// ── Opening the chat on screen ─────────────────────────────────────────────
export interface BotChatDeps {
  /** Scope new sessions to the bot (`fleet.setActiveBot`). */
  setActiveBot: (profile: string) => Promise<void> | void
  /** Bring a stored chat on screen: shared resume + activation. */
  openChat: (storedId: string) => Promise<void>
}

let depsOverride: BotChatDeps | null = null
/** Scripts inject fake deps here (no RN, no chat store); apps never do. */
export function _useBotChatDepsForTests(d: BotChatDeps | null) {
  depsOverride = d
}

async function botChatDeps(): Promise<BotChatDeps> {
  if (depsOverride) return depsOverride
  const [fleet, chat] = await Promise.all([import('./fleet'), import('./chat')])
  return {
    setActiveBot: (profile) => fleet.setActiveBot(profile),
    openChat: async (storedId) => {
      // `resumeShared` is THE shared resume primitive — one in-flight resume
      // per stored id, so a tap racing a switch cannot mint a second live
      // handle. Unlike `switchToSession` it FAILS LOUDLY on a missing chat
      // (the bot screen turns that into an alert) instead of quietly landing
      // the user in a brand-new empty chat.
      const before = chat.activeSession.get()
      const r = await chat.resumeShared(storedId)
      // `runResume` only re-points the screen for a chat the app was already
      // tracking; a cold open from the bot screen leaves the tab on the
      // PREVIOUS conversation, so activate here — unless something moved the
      // screen while the resume was in flight (that tap wins).
      if (chat.activeSession.get() === before) chat.activeSession.set(r.sessionId)
      // The user is looking at this chat now: its badge is served.
      const { clearAttention } = await import('./attention')
      clearAttention(r.storedId)
      // Boot restores this key, so a relaunch lands back in the bot chat.
      const storage = (await import('@react-native-async-storage/async-storage')).default
      void storage.setItem(chat.SESSION_KEY, r.storedId).catch(() => {})
    },
  }
}

// ── Create + claim ─────────────────────────────────────────────────────────
type CreateOutcome = { kind: 'created'; storedId: string } | { kind: 'conflict' }

async function createBotChat(profile: string): Promise<CreateOutcome> {
  let res: { session_id?: unknown; stored_session_id?: unknown }
  try {
    res = await botRpc('session.create', {
      profile,
      title: BOT_CHAT_TITLE,
      hidden: true,
      follow_profile_config: true,
      cols: CREATE_COLS,
      source: 'mobile',
    })
  } catch (err) {
    throw botChatFailure(
      `Could not start ${profile}'s ${BOT_CHAT_TITLE}: ${errMessage(err)}`,
    )
  }
  const runtimeId = typeof res?.session_id === 'string' ? res.session_id.trim() : ''
  if (!runtimeId) {
    throw botChatFailure(
      `Could not start ${profile}'s ${BOT_CHAT_TITLE}: the gateway returned no session id`,
    )
  }
  // session.create is lazy (row on first prompt). Writing the title NOW
  // persists the row + name, which is what makes the canonical chat visible
  // to every other client immediately — and what makes a concurrent create
  // collide on the title instead of quietly minting a second chat.
  let titleRes: { pending?: unknown }
  try {
    titleRes = await botRpc<{ pending?: unknown }>('session.title', {
      session_id: runtimeId,
      title: BOT_CHAT_TITLE,
    })
  } catch (err) {
    if (/already in use/i.test(errMessage(err))) return { kind: 'conflict' }
    throw botChatFailure(
      `Could not claim ${profile}'s ${BOT_CHAT_TITLE}: ${errMessage(err)}`,
    )
  }
  if (titleRes?.pending === true) {
    // The gateway accepted the name but could not write the row yet: it is
    // queued and lands with the first prompt (or the next title read). The
    // chat is real and resumable by its stored id, so the tap must still
    // open it — the queued name is a warning, not a failure.
    log('warn', 'botchat', `${profile}: ${BOT_CHAT_TITLE} title queued (row not persisted yet)`)
  }
  const stored =
    typeof res?.stored_session_id === 'string' && res.stored_session_id.trim()
      ? res.stored_session_id.trim()
      : runtimeId
  return { kind: 'created', storedId: stored }
}

async function openBotChatOnce(profile: string): Promise<string> {
  botChatError.set('')
  const deps = await botChatDeps()
  // Identity FIRST: every session this app creates while the bot is active
  // must live on the bot's profile, so `createSession` keeps scoping new
  // chats to it.
  await deps.setActiveBot(profile)

  const found = await findBotChat(profile)
  if (found) {
    await deps.openChat(found.storedId)
    return found.storedId
  }

  const created = await createBotChat(profile)
  if (created.kind === 'conflict') {
    // Another client (desktop, peer DM, a second phone) claimed the name
    // between our lookup and our title write. Re-run the lookup and adopt the
    // winner; the losing live session stays an empty hidden draft and is reaped.
    const winner = await findBotChat(profile)
    if (!winner) {
      throw botChatFailure(
        `Could not open ${profile}'s ${BOT_CHAT_TITLE} — another client just claimed ` +
          'the name but the chat is not visible yet. Try again.',
      )
    }
    log('info', 'botchat', `${profile}: title race lost — adopting ${winner.storedId}`)
    await deps.openChat(winner.storedId)
    return winner.storedId
  }

  await deps.openChat(created.storedId)
  return created.storedId
}

// One shared in-flight open per profile: a double-tap (or a tap racing the
// screen's own effects) joins the open already running instead of minting a
// second canonical chat. Load-bearing, not an optimization.
const inFlight = new Map<string, Promise<string>>()

/**
 * Open the bot's canonical chat — lookup, create-if-absent, then resume it
 * on the chat screen — and return the chat's STORED id.
 *
 * Single-flight per profile. Throws (and records `botChatError`) rather than
 * ever treating a failed lookup as "absent".
 */
export function openBotChat(profile: string): Promise<string> {
  const name = (profile || '').trim()
  if (!name) return Promise.reject(new Error('No bot profile to open'))
  const running = inFlight.get(name)
  if (running) return running
  const p: Promise<string> = openBotChatOnce(name).finally(() => {
    if (inFlight.get(name) === p) inFlight.delete(name)
  })
  inFlight.set(name, p)
  return p
}
