/** Desktop shell state — layout, active screen, workspace mode.
 * Persisted under localStorage `moch.shell.v1`. */
import { atom } from 'nanostores'

export type Density = 'compact' | 'default' | 'comfortable'
export type ScreenId =
  | 'home'
  | 'chat'
  | 'sessions'
  | 'crew'
  | 'fleet'
  | 'automations'
  | 'agent'
  | 'terminal'
  | 'files'
  | 'browser'
  | 'connectors'
  | 'settings'
  | 'skills'

/** Workspace modes: a preset that focuses a screen and optionally
 * drafts a starter prompt. */
export type ShellMode = 'chat' | 'agent' | 'coding' | 'research'

export const MODE_PRESETS: Record<
  ShellMode,
  { label: string; subtitle: string; screen: ScreenId; draft?: string }
> = {
  chat: { label: 'Chat', subtitle: 'Just talk, get things done', screen: 'chat' },
  agent: { label: 'Agent', subtitle: 'Autonomous tasks & tools', screen: 'home' },
  coding: { label: 'Coding', subtitle: 'Code, terminal, dev tools', screen: 'terminal' },
  research: {
    label: 'Research',
    subtitle: 'Deep research & analysis',
    screen: 'chat',
    draft: '/research ',
  },
}

export interface ShellLayout {
  listCollapsed: boolean
  listWidth: number
  inspectorCollapsed: boolean
  railExpanded: boolean
  density: Density
  screen: ScreenId
  mode: ShellMode
}

export const LIST_MIN = 208
export const LIST_MAX = 384
export const LIST_DEFAULT = 264
export const INSPECTOR_AUTO_COLLAPSE_BELOW = 1280

const KEY = 'moch.shell.v1'
const DEFAULTS: ShellLayout = {
  listCollapsed: false,
  listWidth: LIST_DEFAULT,
  inspectorCollapsed: true,
  railExpanded: false,
  density: 'default',
  screen: 'home',
  mode: 'agent',
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function load(): ShellLayout {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ShellLayout>
    return {
      listCollapsed: !!raw.listCollapsed,
      listWidth: clamp(Number(raw.listWidth) || LIST_DEFAULT, LIST_MIN, LIST_MAX),
      inspectorCollapsed: raw.inspectorCollapsed !== false,
      railExpanded: !!raw.railExpanded,
      density: raw.density === 'compact' || raw.density === 'comfortable' ? raw.density : 'default',
      screen: (typeof raw.screen === 'string' ? raw.screen : 'home') as ScreenId,
      mode: (raw.mode ?? 'agent') as ShellMode,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export const shellLayout = atom<ShellLayout>(load())

export function setShellLayout(patch: Partial<ShellLayout>): void {
  const next: ShellLayout = { ...shellLayout.get(), ...patch }
  if (patch.listWidth != null) next.listWidth = clamp(patch.listWidth, LIST_MIN, LIST_MAX)
  shellLayout.set(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Private-mode storage refusals just stop persistence.
  }
}

/** Apply a workspace mode: sets the mode and focuses its screen. The
 * caller applies any starter draft (needs the chat engine, which this
 * module deliberately does not import). */
export function applyMode(mode: ShellMode): { screen: ScreenId; draft?: string } {
  const preset = MODE_PRESETS[mode]
  setShellLayout({ mode, screen: preset.screen })
  return { screen: preset.screen, draft: preset.draft }
}

export const paletteOpen = atom(false)

export function openPalette(fresh = false): void {
  if (fresh) paletteQuery.set('')
  paletteOpen.set(true)
}

export function closePalette(): void {
  paletteOpen.set(false)
}

export const paletteQuery = atom('')
