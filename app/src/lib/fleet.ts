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

export interface FleetProfile {
  name: string
  description: string
  soul?: string
  frozen?: boolean
  gateHeld?: boolean
  model?: { provider: string; default: string }
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

interface ProfilesListResult {
  profiles?: { name: string; description?: string; ui_meta?: Record<string, unknown> }[]
  items?: { name: string; description?: string }[]
}

/** Refresh the roster + fleet runtime status. Safe to call offline (no-ops). */
export async function refreshFleet(): Promise<void> {
  try {
    const lst = await rpc<ProfilesListResult>('profiles.list', {}, 15000)
    const rows = lst.profiles ?? lst.items ?? (Array.isArray(lst) ? (lst as never) : [])
    fleetProfiles.set(
      (rows as { name: string; description?: string }[]).map((r) => ({
        name: r.name,
        description: r.description ?? '',
      })),
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

export async function createProfile(input: {
  name: string
  description?: string
  soul?: string
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const res = await rpc<{ ok?: boolean; path?: string }>('profiles.create', {
    name: input.name,
    description: input.description ?? '',
    soul: input.soul ?? '',
    no_alias: true,
    mirror_credentials: false,
  })
  await refreshFleet()
  return { ok: res.ok !== false, path: res.path }
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
