/**
 * Native Hermes **Bot Mode** identity (audit: BOT-MODE.md).
 *
 * A Moch "bot" is not a Moch invention: it is a Hermes profile, and Hermes
 * itself decides what a Bot-Mode-managed profile is. The whole source of
 * truth lives on the gateway, and this module only reads/writes the native
 * shape — no parallel bot database, no second identity system.
 *
 * Native contract (verified in the vendored tree, `app/hermes-src/`):
 *  - **Identity = profile** (`hermes_cli/profiles.py`): own `HERMES_HOME` with
 *    `SOUL.md` (persona), `memories/`, `config.yaml` (model, toolsets),
 *    `skills/`, `cron/` and `sessions/`.
 *  - **Managed marker** (`tools/bot_mode_probe.py::_is_bot_managed`): a profile
 *    is Bot-Mode-managed when `profile.yaml` carries
 *    `ui_meta['hermes-bots']`. Its `title` is the roster display name
 *    (`hermes_cli/profiles.py` → `bot_title`); a managed install is what makes
 *    Hermes inject the teammate protocol (`get_bot_mode_protocol_section`) and
 *    the `message_agent` DM tool into that bot's sessions. Unmarked profiles
 *    are ordinary profiles — exactly the bug this module fixes.
 *  - **Canonical conversation** (`hermes_state.CANONICAL_BOT_CHAT_TITLE`): the
 *    hidden session titled exactly `Bot Chat` on that profile. The server
 *    resolves it on every `profiles.list` (`canonical_session`, with
 *    `resolved_id` = the live compression tip) and by exact-title lookup.
 *  - **Write door** (`tui_gateway/methods_profiles.py::_configure_ui_meta`):
 *    `profiles.configure { name, ui_meta, ui_meta_expected_revisions }` merges
 *    the block key-wise with per-key CAS (`_ui_meta_revisions`).
 *
 * Pure module (no React Native, no gateway import) so `scripts/` can exercise
 * it in plain node.
 */

/** The native marker key. Its presence is what Hermes calls "Bot-Mode-managed". */
export const BOT_META_KEY = 'hermes-bots'

/** The native block. Hermes currently reads `title`; unknown keys are preserved. */
export interface BotModeMeta {
  /** Roster display name (`hermes_cli/profiles.py` `bot_title`). */
  title: string
}

/** The raw marker block (unknown desktop keys included), or null when unmanaged. */
function rawBotModeBlock(uiMeta: unknown): Record<string, unknown> | null {
  if (!uiMeta || typeof uiMeta !== 'object' || Array.isArray(uiMeta)) return null
  const block = (uiMeta as Record<string, unknown>)[BOT_META_KEY]
  return block && typeof block === 'object' && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : null
}

/** What Hermes reads from the marker, or null when the profile is unmanaged. */
export function readBotModeMeta(uiMeta: unknown): BotModeMeta | null {
  const block = rawBotModeBlock(uiMeta)
  if (!block) return null
  const rawTitle = block.title
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  return { title }
}

/** True when `ui_meta` carries the native Bot Mode marker (`_is_bot_managed`). */
export function isBotModeManaged(uiMeta: unknown): boolean {
  return readBotModeMeta(uiMeta) !== null
}

/** A per-key CAS revision (`_ui_meta_revisions`), clamped like the gateway does. */
export function uiMetaRevision(revisions: unknown, key: string = BOT_META_KEY): number {
  if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) return 0
  const raw = (revisions as Record<string, unknown>)[key]
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0
}

/**
 * The name every surface shows for a profile, in native Bot Mode precedence:
 * the marker title, else the profile's `display_name`, else the folder id;
 * the launch profile reads as the product name `Moch`.
 */
export function botDisplayTitle(
  profile: string,
  uiMeta: unknown,
  opts: { displayName?: string; isDefault?: boolean } = {},
): string {
  const name = (profile || '').trim()
  const marked = readBotModeMeta(uiMeta)?.title
  const display = typeof opts.displayName === 'string' ? opts.displayName.trim() : ''
  const title = marked || display || name
  return opts.isDefault ? 'Moch' : title
}

/** The `profiles.configure` params that turn a profile into a Bot-Mode-managed bot.
 *  `expected` is the marker's current CAS revision (0 when the key is absent, which
 *  is what `_configure_ui_meta` compares against), so a concurrent desktop write
 *  loses to us instead of being silently overwritten. */
export function botModeMarkerPatch(
  profile: string,
  opts: { title?: string; revisions?: unknown; existing?: unknown } = {},
): { ui_meta: Record<string, unknown>; ui_meta_expected_revisions: Record<string, number> } {
  const name = (profile || '').trim()
  const current = readBotModeMeta(opts.existing)
  const title = (opts.title || current?.title || name).trim() || name
  return {
    // Merge, never replace: unknown keys another client wrote stay intact
    // (`_configure_ui_meta` replaces this KEY's value, so spread the block).
    ui_meta: { [BOT_META_KEY]: { ...(rawBotModeBlock(opts.existing) ?? {}), title } },
    ui_meta_expected_revisions: { [BOT_META_KEY]: uiMetaRevision(opts.revisions) },
  }
}

/** RPC shape needed by {@link markBotModeManaged}; injected so scripts stay offline. */
export type BotModeRpc = <T>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<T>

/**
 * Mark one profile as Bot-Mode-managed through the NATIVE gateway door.
 * Idempotent and best-effort: an already-managed profile returns `false`
 * without a call; a failed write returns `false` (the caller retries on the
 * next roster refresh) instead of breaking the roster paint.
 */
export async function markBotModeManaged(
  profile: string,
  rpc: BotModeRpc,
  opts: { title?: string; revisions?: unknown; existing?: unknown; timeoutMs?: number } = {},
): Promise<boolean> {
  const name = (profile || '').trim()
  if (!name) return false
  if (isBotModeManaged(opts.existing)) return false
  try {
    const res = await rpc<{ applied?: { ui_meta?: unknown } }>(
      'profiles.configure',
      { name, ...botModeMarkerPatch(name, opts) },
      opts.timeoutMs ?? 15000,
    )
    // CAS mismatch comes back as `applied.ui_meta: false` (+ conflicts), not a
    // thrown RPC error: another client wrote the marker first, so this is a
    // no-op, not a success (the next roster refresh sees its title).
    return res?.applied?.ui_meta !== false
  } catch {
    return false
  }
}
