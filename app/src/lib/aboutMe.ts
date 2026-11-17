/**
 * "About me" — what Moch remembers about the user (ONBOARDING-V2).
 *
 * The storage is hermes' own curated user profile (`memories/USER.md`), written
 * through the gateway RPC `moch.profile.about`, which uses MemoryStore itself
 * (same format, same char budget, same injection scan the agent reads). There is
 * deliberately no second store on the phone.
 */
import { atom } from 'nanostores'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { rpc } from './gateway'
import { log } from './log'

const ONBOARDED_KEY = 'hermes.onboarded.v1'

export const onboardedAtom = atom<boolean>(false)
export const aboutEntriesAtom = atom<string[]>([])

export async function loadOnboarded(): Promise<void> {
  try {
    onboardedAtom.set((await AsyncStorage.getItem(ONBOARDED_KEY)) === '1')
  } catch {
    onboardedAtom.set(false)
  }
}

export async function setOnboarded(v = true): Promise<void> {
  onboardedAtom.set(v)
  try {
    await AsyncStorage.setItem(ONBOARDED_KEY, v ? '1' : '0')
  } catch {
    // best effort — the gate re-asks next launch, never blocks chat
  }
}

interface AboutResult {
  ok?: boolean
  entries?: string[]
  added?: string[]
  skipped?: string[]
  errors?: string[]
  path?: string
}

export async function readAbout(): Promise<string[]> {
  try {
    const r = await rpc<AboutResult>('moch.profile.about', { mode: 'read' }, 15000)
    const entries = Array.isArray(r?.entries) ? r.entries : []
    aboutEntriesAtom.set(entries)
    return entries
  } catch (e) {
    log('warn', 'about', `read failed: ${String(e)}`)
    return aboutEntriesAtom.get()
  }
}

/**
 * Replace the profile with the wizard's three answers (name / work / anything
 * else). Empty lines are dropped; the RPC dedupes and enforces the budget.
 */
export async function saveAbout(fields: { name?: string; work?: string; extra?: string }): Promise<{ ok: boolean; error?: string }> {
  const entries = [
    fields.name?.trim() ? `The user's name is ${fields.name.trim()}.` : '',
    fields.work?.trim() ? `What they do: ${fields.work.trim()}.` : '',
    fields.extra?.trim() ?? '',
  ].filter(Boolean)
  if (!entries.length) return { ok: true }
  try {
    const r = await rpc<AboutResult>('moch.profile.about', { mode: 'replace', entries }, 25000)
    aboutEntriesAtom.set(Array.isArray(r?.entries) ? r.entries : entries)
    if (r?.errors?.length) return { ok: false, error: r.errors.join('; ') }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Append one remembered fact later (Settings / chat). */
export async function remember(text: string): Promise<boolean> {
  const entry = text.trim()
  if (!entry) return false
  try {
    const r = await rpc<AboutResult>('moch.profile.about', { mode: 'add', entries: [entry] }, 15000)
    if (Array.isArray(r?.entries)) aboutEntriesAtom.set(r.entries)
    return r?.ok !== false
  } catch {
    return false
  }
}
