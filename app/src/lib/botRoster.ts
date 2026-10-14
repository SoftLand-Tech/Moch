/**
 * Bots-first roster helpers (2026-10-14 UI revamp, UI-007): the drawer and the
 * chat empty state both render the user's bots as the PRIMARY surface — tap a
 * bot and you're in its conversation (the Grok Bot model). Pure module on
 * purpose (regression-tested in scripts/test-bots-first.ts): no RN, no stores.
 */
import { toMs } from './sessionList'

export interface BotCard {
  /** Stable identity — the profile name ('default' cards key as 'default'). */
  key: string
  name: string
  description: string
  /** The always-present default agent card (Moch) — synthesized if the
   *  gateway's profiles.list doesn't include it. */
  isDefault: boolean
  /** Deterministic avatar-disc color bucket (0-3) — stable per name. */
  colorIndex: number
  /** Deterministic mochi-children avatar (0..avatarCount-1); -1 when no
   *  avatar set is supplied — renderers fall back to the color disc. */
  avatarIndex: number
}

/** The default agent answers to these (BUG-112: absent or `default` = Moch). */
function isDefaultName(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n === 'default' || n === 'moch'
}

/** Stable 0-3 bucket from the name — deterministic across launches/themes. */
export function colorIndexFor(name: string): number {
  return stableHash(name) % 4
}

/** Stable face assignment for a bot given the avatar set size (UI-009). */
export function avatarIndexFor(name: string, avatarCount: number): number {
  return avatarCount > 0 ? stableHash(name) % avatarCount : -1
}

function stableHash(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h
}

/**
 * The bots-first roster: the default agent card FIRST (always present), then
 * the gateway's other profiles in server order, default-named entries deduped.
 * `avatarCount` (the mochi-children set size) assigns each bot a stable face;
 * 0 disables the assignment (renderers fall back to color discs).
 */
export function botRoster(
  profiles: { name: string; description?: string }[],
  avatarCount = 0,
): BotCard[] {
  const cards: BotCard[] = [
    { key: 'default', name: 'Moch', description: '', isDefault: true, colorIndex: 0, avatarIndex: -1 },
  ]
  for (const p of profiles) {
    if (isDefaultName(p.name)) continue
    cards.push({
      key: p.name,
      name: p.name,
      description: p.description ?? '',
      isDefault: false,
      colorIndex: colorIndexFor(p.name),
      avatarIndex: avatarCount > 0 ? stableHash(p.name) % avatarCount : -1,
    })
  }
  return cards
}

/**
 * The bot's most recent conversation (stored id), or null when the bot has
 * none — the resume-or-start decision for every "talk to this bot" tap.
 * Recency mirrors the drawer: server started_at overlaid with the local
 * revive-to-top bump so a just-active bot chat wins.
 */
export function pickLatestBotChat(
  rows: { id: string; profile?: string; started_at?: number | null }[],
  name: string,
  lastActive?: Record<string, number>,
): string | null {
  let best: { id: string; ts: number } | null = null
  for (const r of rows) {
    if (r.profile !== name) continue
    const ts = Math.max(toMs(r.started_at), lastActive?.[r.id] ?? 0)
    if (!best || ts > best.ts) best = { id: r.id, ts }
  }
  return best?.id ?? null
}
