/**
 * Fleet (bots) state — port of the phone's src/lib/fleet.ts; same RPCs,
 * localStorage instead of AsyncStorage. The roster IS the desktop home.
 */

import { atom } from 'nanostores'
import { rpc } from './gateway'

const ACTIVE_BOT_KEY = 'moch.desktop.activeBot.v1'

/** The bot whose identity new chats take. Null = the default agent ("Mochi"). */
export const activeBotAtom = atom<string | null>(null)

import { computed } from 'nanostores'
/** Display name of the active bot (null = default agent). */
export const activeBotName = computed(activeBotAtom, (b) => b)

export function loadActiveBot(): void {
  try {
    activeBotAtom.set(localStorage.getItem(ACTIVE_BOT_KEY))
  } catch { /* default */ }
}

export async function setActiveBot(name: string | null): Promise<void> {
  activeBotAtom.set(name)
  try {
    if (name) localStorage.setItem(ACTIVE_BOT_KEY, name)
    else localStorage.removeItem(ACTIVE_BOT_KEY)
  } catch { /* best-effort */ }
}

export interface FleetProfile {
  name: string
  description: string
  soul?: string
  frozen?: boolean
  gateHeld?: boolean
  model?: { provider: string; default: string }
  uiMeta?: Record<string, unknown>
  avatarAccent?: string
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

export const fleetProfiles = atom<FleetProfile[]>([])
export const fleetStatusAtom = atom<FleetStatus | null>(null)
export const fleetError = atom<string>('')

/** Deterministic accent color per bot name (dots.id color-as-identity pattern). */
const ACCENTS = ['#f79236', '#4ade80', '#60a5fa', '#fa9b6a', '#c084fc', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb7185']
export function accentFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return ACCENTS[h % ACCENTS.length]
}

interface ProfilesListResult {
  profiles?: { name: string; description?: string; ui_meta?: Record<string, unknown>; frozen?: boolean; model?: { provider: string; default: string } }[]
  items?: { name: string; description?: string }[]
}

export async function refreshFleet(): Promise<void> {
  try {
    const lst = await rpc<ProfilesListResult>('profiles.list', {}, 15000)
    const rows = lst.profiles ?? lst.items ?? (Array.isArray(lst) ? (lst as never) : [])
    fleetProfiles.set(
      (rows as { name: string; description?: string; ui_meta?: Record<string, unknown>; frozen?: boolean; model?: { provider: string; default: string } }[]).map((r) => ({
        name: r.name,
        description: r.description ?? '',
        uiMeta: r.ui_meta,
        frozen: r.frozen,
        model: r.model,
        avatarAccent: accentFor(r.name),
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
    fleetStatusAtom.set(null)
  }
}

export interface CreateChecklist {
  copyUserMemory: boolean
  copyMemory: boolean
  skills: string[]
}

const CREATE_DEFAULTS_KEY = 'moch.desktop.fleet.createDefaults.v1'
export const DEFAULT_CHECKLIST: CreateChecklist = { copyUserMemory: true, copyMemory: false, skills: [] }

export function loadCreateDefaults(): CreateChecklist {
  try {
    const raw = localStorage.getItem(CREATE_DEFAULTS_KEY)
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

export function saveCreateDefaults(c: CreateChecklist): void {
  try { localStorage.setItem(CREATE_DEFAULTS_KEY, JSON.stringify(c)) } catch { /* ok */ }
}

export interface LaunchSkill {
  name: string
  description: string
  path: string
}

export async function listLaunchSkills(): Promise<LaunchSkill[]> {
  try {
    const res = await rpc<{ skills?: LaunchSkill[] }>('moch.skills.list', {}, 10000)
    return res.skills ?? []
  } catch {
    return []
  }
}

export interface SeedResult {
  profile: string
  userMemory: string | null
  memory: string | null
  skills: { name: string; result: string }[]
}

export function seedHasSkips(seed: SeedResult): boolean {
  const bad = (v: string | null) => v !== null && v !== 'copied'
  return bad(seed.userMemory) || bad(seed.memory) || seed.skills.some((s) => s.result !== 'copied')
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
    mirror_credentials: true,
  })
  let seed: SeedResult | undefined
  let seedError: string | undefined
  const c = input.checklist
  if (c && (c.copyUserMemory || c.copyMemory || c.skills.length > 0)) {
    try {
      seed = await rpc<SeedResult>('moch.profiles.seed', {
        profile: input.name,
        copy_user_memory: c.copyUserMemory,
        copy_memory: c.copyMemory,
        skills: c.skills,
      }, 20000)
    } catch (e) {
      seedError = e instanceof Error ? e.message : String(e)
    }
  }
  await refreshFleet()
  return { ok: res.ok !== false, path: res.path, seed, seedError }
}

export async function freezeProfile(name: string, frozen: boolean): Promise<void> {
  await rpc('moch.fleet.freeze', { profile: name, frozen }, 10000)
  await refreshFleet()
}

export async function deleteProfile(name: string): Promise<void> {
  await rpc('moch.profiles.delete', { profile: name, confirm: true }, 15000)
  if (activeBotAtom.get() === name) await setActiveBot(null)
  await refreshFleet()
}

export async function mirrorModelKey(profile: string): Promise<{ mirrored: string[] }> {
  return rpc<{ mirrored: string[] }>('moch.profiles.mirror_model_key', { profile }, 15000)
}

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
