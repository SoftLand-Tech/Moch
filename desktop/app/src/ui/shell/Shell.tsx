/** Desktop shell chrome: sidebar (brand, nav, workspace modes, status
 * card), main column with top bar, list pane, main pane, inspector.
 * Layout only — every behaviour comes from the shared engine and the
 * screen components. */
import React from 'react'
import './desktop.css'
import { useStore } from '@nanostores/react'
import {
  applyMode,
  closePalette,
  openPalette,
  setShellLayout,
  shellLayout,
  type ScreenId,
  type ShellMode,
} from './state'
import { SCREENS, SCREEN_ICONS } from './registry'
import { MODE_PRESETS } from './state'
import { IconMoch } from './icons'
import { Palette } from './palette'
import { useThemeVersion } from './themeVars'
import { connectionState, everConnected, connConfig } from '../../core/boot'
import './desktop.css'

const MODES: Array<{ id: ShellMode; label: string; subtitle: string }> = (
  Object.keys(MODE_PRESETS) as ShellMode[]
).map((m) => ({ id: m, label: MODE_PRESETS[m].label, subtitle: MODE_PRESETS[m].subtitle }))

const MODE_GLYPH: Record<ShellMode, string> = { chat: '💬', agent: '⚡', coding: '⌘', research: '🔭' }

const SIDEBAR_NAV: Array<ScreenId> = [
  'home',
  'sessions',
  'fleet',
  'automations',
  'files',
  'connectors',
  'skills',
  'settings',
]

function Sidebar(props: {
  active: ScreenId
  mode: ShellMode
  online: boolean
  provider: string
  onNavigate: (id: ScreenId) => void
  onMode: (m: ShellMode) => void
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <IconMoch size={30} />
        </div>
        <div>
          <div className="brand-name">Moch</div>
          <div className="brand-sub">Your Hermes AI Agent</div>
        </div>
      </div>

      <nav className="side-nav" aria-label="Screens">
        {SCREENS.filter((s) => SIDEBAR_NAV.includes(s.id)).map((s) => {
          const Icon = SCREEN_ICONS[s.id]
          const active = s.id === props.active
          return (
            <button
              key={s.id}
              className={active ? 'side-item active' : 'side-item'}
              onClick={() => props.onNavigate(s.id)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={18} />
              <span className="side-label">{s.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="side-section">WORKSPACE MODES</div>
      <div className="side-modes">
        {MODES.map((m) => {
          const active = m.id === props.mode
          return (
            <button
              key={m.id}
              className={active ? 'side-item mode active' : 'side-item mode'}
              onClick={() => props.onMode(m.id)}
              aria-current={active ? 'true' : undefined}
            >
              <span className="mode-glyph" aria-hidden>
                {MODE_GLYPH[m.id]}
              </span>
              <span className="mode-text">
                <span className="mode-label">{m.label}</span>
                <span className="mode-sub">{m.subtitle}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="side-card">
        <IconMoch size={34} />
        <div>
          <div className="side-card-name">Moch</div>
          <div className="side-card-sub">
            <span className={props.online ? 'dot green' : 'dot orange'} />
            {props.online ? 'Online' : 'Offline'}
            {props.provider ? ` · ${props.provider}` : ''}
          </div>
        </div>
      </div>
    </aside>
  )
}

function TopBar(props: { active: ScreenId; onSearch: () => void }): React.JSX.Element {
  const meta = SCREENS.find((s) => s.id === props.active)
  const Icon = SCREEN_ICONS[props.active]
  return (
    <div className="topbar">
      <div className="topbar-title">
        <Icon size={17} />
        <span>{meta?.label ?? props.active}</span>
      </div>
      <button className="search-trigger" onClick={props.onSearch} aria-label="Search (Ctrl+K)">
        <span aria-hidden>⌕</span>
        <span>Search…</span>
        <kbd>Ctrl K</kbd>
      </button>
    </div>
  )
}

export interface ShellProps {
  active: ScreenId
  mode: ShellMode
  list?: React.ReactNode
  inspector?: React.ReactNode
  children: React.ReactNode
  onNavigate: (id: ScreenId) => void
  onOpenChatDraft: (draft: string) => void
}

export function Shell(props: ShellProps): React.JSX.Element {
  useThemeVersion()
  const layout = useStore(shellLayout)
  const state = useStore(connectionState)
  const ever = useStore(everConnected)
  const cfg = useStore(connConfig)
  const online = state === 'open' || ever
  const showList = props.list != null && !layout.listCollapsed && props.active === 'chat'
  const measure = props.active === 'chat' || props.active === 'skills' || props.active === 'settings'

  const navigate = (id: ScreenId) => {
    setShellLayout({ screen: id })
    props.onNavigate(id)
  }
  const onMode = (m: ShellMode) => {
    const applied = applyMode(m)
    props.onNavigate(applied.screen)
    if (applied.draft) props.onOpenChatDraft(applied.draft)
  }
  const provider = cfg ? (cfg.host.startsWith('127.0.0.1') ? 'local runtime' : cfg.host) : ''

  return (
    <div className="shell">
      <Sidebar
        active={props.active}
        mode={props.mode}
        online={online}
        provider={provider}
        onNavigate={navigate}
        onMode={onMode}
      />
      <div className="main-col">
        <TopBar active={props.active} onSearch={openPalette} />
        <div className="main-row">
          {showList ? (
            <aside className="pane list-pane" style={{ width: layout.listWidth }}>
              {props.list}
            </aside>
          ) : null}
          <main className={measure ? 'main-pane measured' : 'main-pane'}>
            {props.children}
          </main>
          {props.inspector != null && !layout.inspectorCollapsed ? (
            <aside className="inspector-pane">{props.inspector}</aside>
          ) : null}
        </div>
      </div>
      <Palette onOpenChatDraft={props.onOpenChatDraft} />
    </div>
  )
}

/* The draggable list-pane splitter lives beside the pane in App.tsx where
 * the pane is mounted; kept out of this module so the shell stays layout
 * only. */
export { closePalette }
