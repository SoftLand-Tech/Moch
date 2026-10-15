/** Screen registry — one table drives the rail, Ctrl+digit map, and the
 * palette's screen entries. */
import type { ComponentType } from 'react'
import type { ScreenId } from './state'
import {
  IconBrowser,
  IconChat,
  IconChip,
  IconCrew,
  IconCube,
  IconGear,
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

export const SCREENS: ScreenEntry[] = [
  { id: 'chat', label: 'Chat', digit: '1', icon: IconChat },
  { id: 'sessions', label: 'Chats', digit: '2', icon: IconList },
  { id: 'crew', label: 'Crew', digit: '3', icon: IconCrew },
  { id: 'fleet', label: 'Fleet', digit: '4', icon: IconChip },
  { id: 'automations', label: 'Automations', digit: '5', icon: IconTimer },
  { id: 'agent', label: 'Models', digit: '6', icon: IconCube },
  { id: 'terminal', label: 'Terminal', digit: '7', icon: IconTerminal },
  { id: 'browser', label: 'Browser', digit: '8', icon: IconBrowser },
  { id: 'connectors', label: 'Connectors', digit: '9', icon: IconLink },
  { id: 'settings', label: 'Settings', digit: '0', icon: IconGear },
  { id: 'skills', label: 'Skills', digit: null, icon: IconSkills },
]

export const SCREEN_ICONS: Record<ScreenId, ComponentType<{ size?: number }>> = Object.fromEntries(
  SCREENS.map((s) => [s.id, s.icon]),
) as Record<ScreenId, ComponentType<{ size?: number }>>

/** Screens whose main content is prose — the 760px measure cap applies. */
export const MEASURE_CAPPED: Record<ScreenId, true> = {
  chat: true,
  skills: true,
  settings: true,
}
