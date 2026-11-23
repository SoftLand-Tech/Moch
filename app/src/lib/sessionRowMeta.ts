/**
 * Pure helpers for the Chats-screen row metadata — the honest-row fixes for
 * GH #111 / #63 (BUG-074):
 *
 *  - `searchHitToRow`: the `/api/sessions/search` content-hit → SessionRow
 *    mapping. The server DOES send `message_count` and `source` on rich hits
 *    (hermes_cli/web_routers/sessions.py), but the old inline construction
 *    dropped them, so every content-search row rendered "0 msgs" (#111).
 *  - `messageCountText`: unknown counts render as "—" instead of a lying 0.
 *  - `optimisticSessionRow`: a just-created chat has NO known message count —
 *    leave it undefined so the same "—" applies (the row self-heals ≤60s via
 *    the session.list poll).
 *  - `sourceLabel`: known `source` tokens localized; anything else verbatim.
 *  - `isDeleteRefusalBusy`: the gateway's "cannot delete an active session"
 *    refusal (methods_session.py:983) mapped to friendly copy at the call
 *    site instead of surfacing raw server English.
 *
 * Extracted from the screen so scripts/ can unit-test every branch in plain
 * node — this file must stay free of react-native/expo imports (the tr()
 * catalog pulls AsyncStorage, so translators are passed in as functions).
 */

/**
 * One row of the server's conversation list. Canonical home is HERE (not
 * lib/sessionList, which re-exports it): this module must stay importable
 * from scripts/ without dragging sessionList's gateway→RN graph into the
 * scripts tsconfig program, whose node+DOM lib mix breaks unrelated
 * ambient-typed files there.
 */
export interface SessionRow {
  /** Durable id — the one `session.resume` takes. */
  id: string
  title?: string
  preview?: string
  /** Unix SECONDS, with a fractional part. */
  started_at?: number
  message_count?: number
  source?: string
  /**
   * Owning profile (M9.2 bots). Absent or `default` = the default agent.
   * BUG-112: `session.list` is profile-scoped server-side and the client used
   * to ask for the active profile only, so a bot's conversations disappeared
   * from the drawer and Chats screen after an app restart even though they were
   * still on disk. Rows now carry the profile they came from.
   */
  profile?: string
  /** Working directory the session was created in (server `cwd`). Drives the
   *  drawer's project filter via `projectForCwd` when a row has no project id. */
  cwd?: string
  /** Owning project id, when the gateway stamps rows with one. */
  project_id?: string
  /**
   * Born-hidden flag, when a gateway build sends it. Canonical Bot Chats are
   * created hidden (`session.create {hidden: true}` in lib/botChat) and the
   * plain `session.list` contract already excludes them server-side — but a
   * peer that ignores `include_hidden`, or a row whose hidden flag was lost
   * and later restored, must still never surface as an ordinary chat. Absent
   * on most rows today; honoured whenever present.
   */
  hidden?: boolean
}

/**
 * The canonical Bot Chat's title. Identity, not decoration: Hermes resolves
 * a bot's ONE conversation by this exact name
 * (`hermes_state.CANONICAL_BOT_CHAT_TITLE`; lib/botChat's `BOT_CHAT_TITLE`
 * is the same string). Kept as a literal here so this module stays
 * import-free — the scripts suites load it in plain node.
 */
export const BOT_CHAT_TITLE = 'Bot Chat'

/**
 * THE bot-session classifier — the single rule every Sessions surface
 * (drawer Recent Chats, the Sessions/Chats screen, project mini-lists,
 * content-search hits) applies, so bots and sessions can never drift apart
 * again. A row is a BOT session when ANY of these hold:
 *
 *  1. `profile` names a real bot profile (present and not `default` — the
 *     launch profile's ordinary chats are Sessions; its Bot Chat is caught
 *     by rule 2). This is the marker the gateway stamps on profile-scoped
 *     rows, and the one the Bot Mode audit (BOT-MODE.md) built on.
 *  2. Its title is exactly the canonical `Bot Chat` title — that name is
 *     RESERVED identity, never an ordinary chat's name, whatever profile
 *     column the row carries (legacy rows minted in the launch profile, or
 *     rows that lost their profile stamp, are still bot chats).
 *  3. It is flagged `hidden` — hidden rows are owned by the Bots surface
 *     (and pickers that explicitly ask for them), never by Sessions.
 *
 * Deliberately NOT here: in-memory `sessionsById` entries carry no profile
 * column. The ones that are bot chats are registered in lib/chat's
 * server-only set (`isServerOnlySession`) at the moment a bot chat opens,
 * and surfaces must check that set too — see ScreenShell's drawer list.
 */
export function isBotSessionRow(row: {
  profile?: string | null
  title?: string | null
  hidden?: boolean | null
}): boolean {
  if (row.hidden === true) return true
  if (row.profile && row.profile !== 'default') return true
  return (row.title ?? '').trim() === BOT_CHAT_TITLE
}

/**
 * Every source token the gateway itself mints (session_lifecycle.py's
 * _NON_GATEWAY_SOURCES, plus "mobile" — the platform this app's sessions
 * resolve to, see toolsets.py) and the messaging platforms with first-class
 * toolsets. Unknown tokens fall back to the raw string by design: the
 * gateway accepts arbitrary client-declared sources and plugin platforms.
 */
const SOURCE_KEYS: Record<string, string> = {
  mobile: 'sessions.source.mobile',
  tui: 'sessions.source.tui',
  cli: 'sessions.source.cli',
  webui: 'sessions.source.webui',
  desktop: 'sessions.source.desktop',
  cron: 'sessions.source.cron',
  kanban: 'sessions.source.kanban',
  subagent: 'sessions.source.subagent',
  test: 'sessions.source.test',
  local: 'sessions.source.local',
  acp: 'sessions.source.acp',
  webhook: 'sessions.source.webhook',
  api_server: 'sessions.source.api_server',
  msgraph_webhook: 'sessions.source.msgraph_webhook',
  telegram: 'sessions.source.telegram',
  discord: 'sessions.source.discord',
  whatsapp: 'sessions.source.whatsapp',
  slack: 'sessions.source.slack',
  signal: 'sessions.source.signal',
  email: 'sessions.source.email',
  sms: 'sessions.source.sms',
}

/**
 * Localized label for a row's `source`, '' when absent, the RAW token when
 * unknown (never a blank lie). `t` is `tr` at the call site.
 */
export function sourceLabel(source: string | null | undefined, t: (key: string) => string): string {
  const raw = typeof source === 'string' ? source : ''
  if (!raw.trim()) return ''
  const key = SOURCE_KEYS[raw.trim().toLowerCase()]
  return key ? t(key) : raw
}

/** "5" for a known count, "—" for unknown — never a lying "0". */
export function messageCountText(count: number | null | undefined): string {
  return typeof count === 'number' && Number.isFinite(count) ? String(count) : '—'
}

/**
 * One `/api/sessions/search` result → a renderable row. Returns null when
 * the hit carries no usable session id. `message_count`/`source` pass through
 * only when the server actually sent them (#111) — absent stays undefined so
 * the meta line renders "— msgs" rather than "0 msgs".
 */
export function searchHitToRow(r: Record<string, unknown>): SessionRow | null {
  const id = typeof r.session_id === 'string' || typeof r.session_id === 'number' ? String(r.session_id) : ''
  if (!id) return null
  const row: SessionRow = {
    id,
    title: typeof r.title === 'string' ? r.title : undefined,
    // The snippet IS the matching content — show it where a row shows its
    // preview, so a content hit reads as "why this matched".
    preview: typeof r.snippet === 'string' ? r.snippet.replace(/\s+/g, ' ').trim() : undefined,
    started_at: typeof r.started_at === 'number' ? r.started_at : undefined,
    profile: typeof r.profile === 'string' ? r.profile : undefined,
    message_count: typeof r.message_count === 'number' ? r.message_count : undefined,
    source: typeof r.source === 'string' ? r.source : undefined,
    hidden: typeof r.hidden === 'boolean' ? r.hidden : undefined,
  }
  // Content search runs over every profile's store on some gateways: a hit
  // inside a bot's chat is a bot session, and the Sessions screen is not
  // its surface — drop it here so no caller can leak it by forgetting to
  // filter (the screen filters again, belt and braces).
  if (isBotSessionRow(row)) return null
  return row
}

/**
 * The optimistic just-created chat row. `message_count` is deliberately
 * absent (BUG-074/#111): the client cannot know it, so the row renders
 * "— msgs" until the next `session.list` poll replaces it with the server's
 * honest count — no local bump machinery, the ≤60s poll self-heals it.
 */
export function optimisticSessionRow(storedId: string, title: string, startedAtSec: number): SessionRow {
  return { id: storedId, title, started_at: startedAtSec, source: 'mobile' }
}

/** The gateway's delete refusal for a session that is live in its process. */
const DELETE_ACTIVE_RE = /cannot delete an active session/i
export function isDeleteRefusalBusy(err: unknown): boolean {
  return err instanceof Error && DELETE_ACTIVE_RE.test(err.message)
}
