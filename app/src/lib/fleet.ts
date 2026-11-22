/**
 * Fleet (M9.2): typed helpers + state for the bots surface.
 *
 * Everything rides the existing gateway RPC (same socket as chat). Feature
 * detection is live: `moch.fleet.status` answers only when the gateway runs
 * the fleet runtime (MOCH_FLEET=1); `profiles.list` always answers, so the
 * Fleet screen can show the single default bot as "Moch" even pre-flag
 * (B12: zero profiles ⇒ this surface is just a friendly entry point).
 */
import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { rpc } from './gateway'
import { botDisplayTitle, isBotModeManaged, markBotModeManaged } from './botMode'
import { ensureBotChat } from './botChat'

const ACTIVE_BOT_KEY = 'hermes.fleet.activeBot.v1'

/**
 * The bot whose identity new chats take (M9.2). Null = the default "Moch"
 * experience (B12). Persisted so kill/reopen keeps talking to the same bot.
 */
export const activeBotAtom = atom<string | null>(null)

export async function loadActiveBot(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(ACTIVE_BOT_KEY)
    if (saved) activeBotAtom.set(saved)
  } catch {
    // storage failure = default bot; harmless
  }
}

export async function setActiveBot(name: string | null): Promise<void> {
  activeBotAtom.set(name)
  try {
    if (name) await AsyncStorage.setItem(ACTIVE_BOT_KEY, name)
    else await AsyncStorage.removeItem(ACTIVE_BOT_KEY)
  } catch {
    // best-effort persistence
  }
}

export function getActiveBot(): string | null {
  return activeBotAtom.get()
}

/** The profile's canonical "Bot Chat" registry row, when the gateway reports
 *  one (`profiles.list` with `include_sessions`). `id` is the stored registry
 *  row; `resolvedId` is the live compression tip. Its NAME is the identity —
 *  see `lib/botChat.ts`, which never mints a second one. */
export interface FleetCanonicalSession {
  id: string
  resolvedId?: string
  title?: string
  /** Newest message preview from the live tip — the roster row's text. */
  preview?: string
  /** Last-activity seconds (fractional) of the live tip. */
  lastActive?: number
  messageCount?: number
}

export interface FleetProfile {
  name: string
  /**
   * Display name from the NATIVE Bot Mode identity: `profiles.list` →
   * `ui_meta['hermes-bots'].title`, else `display_name`, else the folder id
   * (the launch profile reads `Moch`). Never a Moch-side alias table.
   */
  title: string
  description: string
  soul?: string
  frozen?: boolean
  gateHeld?: boolean
  model?: { provider: string; default: string }
  /** True for the launch profile — the assistant itself, not a fleet bot. */
  isDefault?: boolean
  /** Present only when the profile carries the native Bot Mode marker. */
  botMode: boolean
  /** Raw `ui_meta` / its per-key CAS revisions, straight from the gateway. */
  uiMeta?: Record<string, unknown>
  uiMetaRevisions?: Record<string, number>
  /** Present only when the profile HAS a canonical Bot Chat. */
  canonicalSession?: FleetCanonicalSession
}

export interface FleetQueueEntry {
  home: string
  priority: string
  seq: number
  queued_s: number
}

export interface FleetStatus {
  fleetEnabled: boolean
  queue: { slots: number; active: number; waiting: FleetQueueEntry[] }
  profiles: { name: string; frozen: boolean; gateHeld: boolean }[]
}

/** Roster from profiles.list — names + descriptions + ui meta. */
export const fleetProfiles = atom<FleetProfile[]>([])
export const fleetStatusAtom = atom<FleetStatus | null>(null)
/** Last refresh error (banner in the Fleet screen; empty = healthy). */
export const fleetError = atom<string>('')

interface ProfilesListRow {
  name: string
  description?: string
  display_name?: string
  is_default?: boolean
  ui_meta?: Record<string, unknown>
  ui_meta_revisions?: Record<string, number>
  /** Roster session fields — only with `include_sessions` (the default). */
  canonical_session?: {
    id?: unknown
    resolved_id?: unknown
    root_title?: unknown
    title?: unknown
    preview?: unknown
    last_active?: unknown
    started_at?: unknown
    message_count?: unknown
  } | null
}

interface ProfilesListResult {
  profiles?: ProfilesListRow[]
  items?: ProfilesListRow[]
}

/** Map the wire's `canonical_session` (snake_case) onto the typed field. All
 *  fields are coerced defensively: an older gateway may omit them. */
function canonicalSessionOf(row: ProfilesListRow): FleetCanonicalSession | undefined {
  const cs = row.canonical_session
  if (!cs || typeof cs !== 'object') return undefined
  const id = typeof cs.id === 'string' ? cs.id.trim() : ''
  if (!id) return undefined
  const resolvedId = typeof cs.resolved_id === 'string' ? cs.resolved_id.trim() : ''
  const rawTitle = typeof cs.title === 'string' ? cs.title : typeof cs.root_title === 'string' ? cs.root_title : ''
  const title = rawTitle.trim()
  const preview = typeof cs.preview === 'string' ? cs.preview : ''
  const rawLastActive =
    typeof cs.last_active === 'number' ? cs.last_active : typeof cs.started_at === 'number' ? cs.started_at : 0
  const lastActive = Number.isFinite(rawLastActive) && rawLastActive > 0 ? rawLastActive : undefined
  const messageCount = typeof cs.message_count === 'number' && Number.isFinite(cs.message_count)
    ? cs.message_count
    : undefined
  return {
    id,
    ...(resolvedId ? { resolvedId } : {}),
    ...(title ? { title } : {}),
    ...(preview ? { preview } : {}),
    ...(lastActive === undefined ? {} : { lastActive }),
    ...(messageCount === undefined ? {} : { messageCount }),
  }
}

/** Refresh the roster + fleet runtime status. Safe to call offline (no-ops). */
export async function refreshFleet(): Promise<void> {
  try {
    // `include_sessions` is an accepted (and default-true) param on every
    // gateway that ships the roster fields; asking explicitly documents the
    // dependency and is ignored by older peers that predate it.
    const lst = await rpc<ProfilesListResult>('profiles.list', { include_sessions: true }, 15000)
    const rows = lst.profiles ?? lst.items ?? (Array.isArray(lst) ? (lst as never) : [])
    const wireRows = rows as ProfilesListRow[]
    fleetProfiles.set(
      wireRows.map((r) => {
        const canonicalSession = canonicalSessionOf(r)
        const isDefault = r.is_default === true || r.name === 'default'
        return {
          name: r.name,
          title: botDisplayTitle(r.name, r.ui_meta, { displayName: r.display_name, isDefault }),
          description: r.description ?? '',
          ...(isDefault ? { isDefault: true } : {}),
          // Native marker: unmarked profiles are ordinary Hermes profiles and
          // are migrated below (best-effort) so legacy Moch bots become real
          // Bot Mode bots instead of staying session containers.
          botMode: isBotModeManaged(r.ui_meta),
          ...(r.ui_meta ? { uiMeta: r.ui_meta } : {}),
          ...(r.ui_meta_revisions ? { uiMetaRevisions: r.ui_meta_revisions } : {}),
          ...(canonicalSession ? { canonicalSession } : {}),
        }
      }),
    )
    fleetError.set('')

  } catch (e) {
    fleetError.set(e instanceof Error ? e.message : String(e))
  }
  try {
    const st = await rpc<FleetStatus>('moch.fleet.status', {}, 8000)
    fleetStatusAtom.set(st)
  } catch {
    fleetStatusAtom.set(null) // fleet runtime not armed on this gateway — fine
  }
}

// ── Native Bot Mode identity on open ───────────────────────────────────────
// Bot Mode activation is the `ui_meta['hermes-bots']` marker (lib/botMode.ts).
// Bots created by Moch get it at creation; profiles that predate the marker are
// upgraded when Moch actually OPENS them as a bot (`openBotChat` →
// `ensureBotModeIdentity`), never by a roster-wide sweep — an unmarked named
// profile may belong to the desktop/CLI, and this marker flips Hermes' global
// `is_bot_mode_managed` gate (teammate protocol + `message_agent`), which we
// only assert for a profile the user is using as a Moch bot.
const identityInFlight = new Set<string>()

/** Make `profile` a Bot-Mode-managed bot through the native configure door.
 *  Idempotent, serialized per profile, best-effort (failure = next open
 *  retries). Carries the roster's CAS revisions so a concurrent desktop write
 *  is never clobbered. */
export async function ensureBotModeIdentity(profile: string): Promise<void> {
  const name = (profile || '').trim()
  if (!name) return
  // The launch profile is the DEFAULT BOT (`Moch`) in Moch's Bot Mode — it
  // gets the same native marker as any named bot.
  const row = fleetProfiles.get().find((p) => p.name === name)
  if (row?.botMode) return
  if (identityInFlight.has(name)) return
  identityInFlight.add(name)
  try {
    // A desktop-set display_name is the human name; the marker title outranks
    // it in native resolution, so carry it over rather than downgrading to the
    // folder id. No title means "use the profile name".
    const display = (row?.title ?? '').trim()
    const ok = await markBotModeManaged(name, rpc, {
      existing: row?.uiMeta,
      revisions: row?.uiMetaRevisions,
      ...(display && display !== name ? { title: display } : {}),
    })
    if (ok) void refreshFleet()
  } finally {
    identityInFlight.delete(name)
  }
}

export interface CreateChecklist {
  /** Copy launch USER.md ("ideas about me") — default ON. */
  copyUserMemory: boolean
  /** Copy launch MEMORY.md too — default OFF (noisy accumulated history). */
  copyMemory: boolean
  /** Selected launch skill names to copy (moch.profiles.seed). */
  skills: string[]
}

const CREATE_DEFAULTS_KEY = 'hermes.fleet.createDefaults.v1'

export const DEFAULT_CHECKLIST: CreateChecklist = {
  copyUserMemory: true,
  copyMemory: false,
  skills: [],
}

/** Persisted so the checklist re-opens with the user's last choices. */
export async function loadCreateDefaults(): Promise<CreateChecklist> {
  try {
    const raw = await AsyncStorage.getItem(CREATE_DEFAULTS_KEY)
    if (!raw) return { ...DEFAULT_CHECKLIST }
    const parsed = JSON.parse(raw) as Partial<CreateChecklist>
    return {
      copyUserMemory: parsed.copyUserMemory ?? DEFAULT_CHECKLIST.copyUserMemory,
      copyMemory: parsed.copyMemory ?? DEFAULT_CHECKLIST.copyMemory,
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    }
  } catch {
    return { ...DEFAULT_CHECKLIST }
  }
}

export async function saveCreateDefaults(c: CreateChecklist): Promise<void> {
  try {
    await AsyncStorage.setItem(CREATE_DEFAULTS_KEY, JSON.stringify(c))
  } catch {
    // best-effort persistence
  }
}

export interface LaunchSkill {
  name: string
  description: string
  path: string
}

/** Skills installed in the launch home (Moch) — for the create checklist. */
export async function listLaunchSkills(): Promise<LaunchSkill[]> {
  try {
    const res = await rpc<{ skills?: LaunchSkill[] }>('moch.skills.list', {}, 10000)
    return res.skills ?? []
  } catch {
    return [] // older gateway without the fleet RPC — picker renders empty
  }
}

export interface SeedResult {
  profile: string
  userMemory: string | null
  memory: string | null
  skills: { name: string; result: string }[]
}

/** True when any seeded item was NOT copied (missing/skipped-exists/…). */
export function seedHasSkips(seed: SeedResult): boolean {
  const bad = (v: string | null) => v !== null && v !== 'copied'
  return bad(seed.userMemory) || bad(seed.memory) ||
    seed.skills.some((s) => s.result !== 'copied')
}

export async function createProfile(input: {
  name: string
  description?: string
  soul?: string
  checklist?: CreateChecklist
}): Promise<{ ok: boolean; path?: string; error?: string; seed?: SeedResult; seedError?: string }> {
  const res = await rpc<{ ok?: boolean; path?: string }>('profiles.create', {
    name: input.name,
    description: input.description ?? '',
    soul: input.soul ?? '',
    no_alias: true,
    // §2.8 default: mirror the launch profile's MODEL key only (never
    // platform/bot tokens) so a fresh bot can actually answer.
    mirror_credentials: true,
  })
  // Bot Mode identity: the profile is born a Bot-Mode-managed bot through the
  // native marker (`profile.yaml` → `ui_meta['hermes-bots']`, see
  // lib/botMode.ts). Without it Hermes would hand the new bot to the world as
  // an ordinary profile — no teammate protocol, no `message_agent`, no
  // native roster title — which is exactly the "bots are session templates"
  // bug. Best-effort: `refreshFleet` retries an unmarked profile.
  await markBotModeManaged(input.name, rpc)
  // Checklist seeding is BEST-EFFORT post-create: the bot exists either way;
  // a seed failure is surfaced, never fatal (never clone_from — that would
  // copy the whole .env/config.yaml and silently upgrade §2.8 mirroring).
  let seed: SeedResult | undefined
  let seedError: string | undefined
  const c = input.checklist
  if (c && (c.copyUserMemory || c.copyMemory || c.skills.length > 0)) {
    try {
      const out = await rpc<SeedResult>('moch.profiles.seed', {
        profile: input.name,
        copy_user_memory: c.copyUserMemory,
        copy_memory: c.copyMemory,
        skills: c.skills,
      }, 20000)
      seed = out
    } catch (e) {
      seedError = e instanceof Error ? e.message : String(e)
    }
  }
  // Every bot HAS its one canonical Bot Chat (native: the hidden session
  // titled exactly `Bot Chat` on this profile). Create it now — after the seed
  // so the build sees the seeded skills/memory — best-effort and
  // non-blocking; the open path (`openBotChat` → `ensureBotChat`) resolves the
  // same row idempotently and self-heals a failed eager create.
  void ensureBotChat(input.name).catch(() => {})
  await refreshFleet()
  return { ok: res.ok !== false, path: res.path, seed, seedError }
}

export async function freezeProfile(name: string, frozen: boolean): Promise<void> {
  await rpc('moch.fleet.freeze', { profile: name, frozen }, 10000)
  await refreshFleet()
}

/** SOUL.md draft from a one-line job description (one cheap LLM call happens
 * server-side later; v1 ships a deterministic template so creation is instant). */
export function soulDraft(job: string, name: string): string {
  return [
    `# ${name}`,
    '',
    job.trim() || 'A helpful Moch fleet bot.',
    '',
    '## Working agreement',
    '- Stay in scope of the job above; ask via a question card when blocked.',
    '- Anything sent to a person is a draft until approved.',
    `- Name for this bot: ${name}.`,
  ].join('\n')
}

export function slugifyName(job: string): string {
  const base = job
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join('-')
  return (base || 'bot').slice(0, 32)
}
