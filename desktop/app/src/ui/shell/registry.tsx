/** Screen registry — one table drives the sidebar, the Ctrl+digit map,
 * and the palette's screen entries. */
import type { ComponentType } from 'react'
import type { ScreenId } from './state'
import {
  IconBrowser,
  IconChat,
  IconChip,
  IconCrew,
  IconCube,
  IconFiles,
  IconGear,
  IconHome,
  IconLink,
  IconList,
  IconSkills,
  IconTerminal,
  IconTimer,
} from './icons'

export interface ScreenEntry {
  id: ScreenId
  label: string
  digit: string | null
  icon: ComponentType<{ size?: number }>
}

/** Sidebar order. */
export const SCREENS: ScreenEntry[] = [
  { id: 'home', label: 'Home', digit: '1', icon: IconHome },
  { id: 'sessions', label: 'Chats', digit: '2', icon: IconList },
  { id: 'fleet', label: 'Agents', digit: '3', icon: IconChip },
  { id: 'automations', label: 'Automations', digit: '4', icon: IconTimer },
  { id: 'files', label: 'Files', digit: '5', icon: IconFiles },
  { id: 'connectors', label: 'Tools', digit: '6', icon: IconLink },
  { id: 'skills', label: 'Skills', digit: null, icon: IconSkills },
  { id: 'terminal', label: 'Terminal', digit: '7', icon: IconTerminal },
  { id: 'browser', label: 'Browser', digit: '8', icon: IconBrowser },
  { id: 'crew', label: 'Crew', digit: null, icon: IconCrew },
  { id: 'settings', label: 'Settings', digit: '0', icon: IconGear },
]

export const SCREEN_ICONS: Record<ScreenId, ComponentType<{ size?: number }>> = Object.fromEntries(
  SCREENS.map((s) => [s.id, s.icon]),
) as Record<ScreenId, ComponentType<{ size?: number }>>

/** Screens whose main content is prose — the 760px measure cap applies. */
export const MEASURE_CAPPED: Partial<Record<ScreenId, true>> = {
  chat: true,
  skills: true,
  settings: true,
}
