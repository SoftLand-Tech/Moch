/**
 * Desktop shell state — layout geometry + the active screen, persisted
 * under localStorage `moch.shell.v1`. One atom, one writer (setShellLayout).
 */
import { atom } from 'nanostores'

export type Density = 'compact' | 'default' | 'comfortable'
export type ScreenId =
  | 'chat'
  | 'sessions'
  | 'crew'
  | 'fleet'
  | 'automations'
  | 'agent'
  | 'terminal'
  | 'browser'
  | 'connectors'
  | 'settings'
  | 'skills'

export interface ShellLayout {
  listCollapsed: boolean
  listWidth: number
  inspectorCollapsed: boolean
  railExpanded: boolean
  density: Density
  screen: ScreenId
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
  screen: 'chat',
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function load(): ShellLayout {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ShellLayout>
    const screen = raw.screen
    return {
      listCollapsed: !!raw.listCollapsed,
      listWidth: clamp(Number(raw.listWidth) || LIST_DEFAULT, LIST_MIN, LIST_MAX),
      inspectorCollapsed: raw.inspectorCollapsed !== false,
      railExpanded: !!raw.railExpanded,
      density: raw.density === 'compact' || raw.density === 'comfortable' ? raw.density : 'default',
      screen: (typeof screen === 'string' ? screen : 'chat') as ScreenId,
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

export const paletteOpen = atom(false)

export function openPalette(fresh = false): void {
  if (fresh) paletteQuery.set('')
  paletteOpen.set(true)
}

export function closePalette(): void {
  paletteOpen.set(false)
}

export const paletteQuery = atom('')
