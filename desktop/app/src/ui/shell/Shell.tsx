/** Desktop shell chrome: nav rail, list pane, main pane, inspector,
 * splitters. Layout only — every behaviour comes from the shared engine
 * and the screen components. */
import React, { useRef, useState } from 'react'
import './desktop.css'
import { useStore } from '@nanostores/react'
import {
  INSPECTOR_AUTO_COLLAPSE_BELOW,
  LIST_DEFAULT,
  LIST_MAX,
  LIST_MIN,
  setShellLayout,
  shellLayout,
  type ScreenId,
} from './state'
import { SCREENS, SCREEN_ICONS, IconMoch } from './registry'
import { Palette } from './palette'
import { useThemeVersion } from './themeVars'
import { connectionState, everConnected } from '../../../../../app/src/lib/gateway'
import type { ConnectionState } from '../../../../../app/src/protocol/json-rpc-gateway'

export interface ShellPane {
  id: ScreenId
  content: React.ReactNode
}

function Rail(props: {
  active: ScreenId
  onNavigate: (id: ScreenId) => void
}): React.JSX.Element {
  const layout = useStore(shellLayout)
  const cls = layout.railExpanded ? 'rail expanded' : 'rail'
  return (
    <nav className={cls} aria-label="Screens">
      <div className="rail-logo" aria-hidden>
        <IconMoch size={26} />
      </div>
      {SCREENS.map((s) => {
        const Icon = SCREEN_ICONS[s.id]
        const active = s.id === props.active
        return (
          <button
            key={s.id}
            className={active ? 'rail-item active' : 'rail-item'}
            onClick={() => props.onNavigate(s.id)}
            aria-current={active ? 'page' : undefined}
            aria-label={s.label}
            title={s.label}
          >
            <Icon size={20} />
            {layout.railExpanded ? <span className="rail-label">{s.label}</span> : null}
          </button>
        )
      })}
      <button
        className="rail-item rail-expand"
        onClick={() => setShellLayout({ railExpanded: !layout.railExpanded })}
        aria-label="Toggle rail labels"
        title="Toggle labels (Ctrl+\\)"
      >
        <span className="rail-dots">⌥</span>
        {layout.railExpanded ? <span className="rail-label">Collapse</span> : null}
      </button>
    </nav>
  )
}

function Splitter(props: {
  width: number
  min: number
  max: number
  onCommit: (w: number) => void
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const [live, setLive] = useState<number | null>(null)
  const start = useRef({ x: 0, w: 0 })
  const shown = live ?? props.width
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={shown}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={0}
      className={hover || live != null ? 'splitter active' : 'splitter'}
      onMouseDown={(e) => {
        start.current = { x: e.pageX, w: props.width }
        const move = (ev: MouseEvent) => {
          setLive(Math.min(props.max, Math.max(props.min, start.current.w + (ev.pageX - start.current.x))))
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          setLive((w) => {
            if (w != null) props.onCommit(w)
            return null
          })
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
      onDoubleClick={() => props.onCommit(LIST_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8
        if (e.key === 'ArrowLeft') props.onCommit(Math.max(props.min, props.width - step))
        else if (e.key === 'ArrowRight') props.onCommit(Math.min(props.max, props.width + step))
        else if (e.key === 'Home') props.onCommit(props.min)
        else if (e.key === 'End') props.onCommit(props.max)
        else return
        e.preventDefault()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    />
  )
}

export function Shell(props: {
  active: ScreenId
  list?: React.ReactNode
  inspector?: React.ReactNode
  children: React.ReactNode
  onNavigate: (id: ScreenId) => void
  onOpenChatDraft: (draft: string) => void
}): React.JSX.Element {
  useThemeVersion()
  const layout = useStore(shellLayout)
  const showList = props.list != null && !layout.listCollapsed && props.active === 'chat'
  const showInspector =
    props.inspector != null && !layout.inspectorCollapsed && window.innerWidth >= INSPECTOR_AUTO_COLLAPSE_BELOW
  const measure = props.active === 'chat' || props.active === 'skills' || props.active === 'settings'
  return (
    <div className={`shell density-${layout.density}`}>
      <div className="shell-body">
        <Rail active={props.active} onNavigate={props.onNavigate} />
        {showList ? (
          <>
            <aside className="pane list-pane" style={{ width: layout.listWidth }}>
              {props.list}
            </aside>
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={layout.listWidth}
              aria-valuemin={LIST_MIN}
              aria-valuemax={LIST_MAX}
              tabIndex={0}
              aria-label="Resize list pane"
              onMouseDown={(e) => {
                const start = { x: e.pageX, w: layout.listWidth }
                const move = (ev: MouseEvent) =>
                  setShellLayout({ listWidth: Math.min(LIST_MAX, Math.max(LIST_MIN, start.w + (ev.pageX - start.x))) })
                const up = () => {
                  window.removeEventListener('mousemove', move)
                  window.removeEventListener('mouseup', up)
                }
                window.addEventListener('mousemove', move)
                window.addEventListener('mouseup', up)
              }}
              onDoubleClick={() => setShellLayout({ listWidth: LIST_DEFAULT })}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 32 : 8
                if (e.key === 'ArrowLeft') setShellLayout({ listWidth: Math.max(LIST_MIN, layout.listWidth - step) })
                else if (e.key === 'ArrowRight') setShellLayout({ listWidth: Math.min(LIST_MAX, layout.listWidth + step) })
                else return
                e.preventDefault()
              }}
            />
          </>
        ) : null}
        <main className={measure ? 'main-pane measured' : 'main-pane'}>{props.children}</main>
        {showInspector ? <aside className="inspector-pane">{props.inspector}</aside> : null}
      </div>
      <StatusBar />
      <Palette onOpenChatDraft={props.onOpenChatDraft} />
    </div>
  )
}

// Splitter component retained for future multi-pane layouts.
export { Splitter }

/** Connection line: one dot + plain words, from the shared gateway stores. */
function StatusBar(): React.JSX.Element {
  const conn = useStore(connectionState)
  const ever = useStore(everConnected)
  const meta: Record<ConnectionState, { tone: string; label: string }> = {
    open: { tone: 'ok', label: 'Connected' },
    connecting: { tone: 'warn', label: 'Connecting…' },
    closed: { tone: ever ? 'warn' : 'off', label: ever ? 'Reconnecting…' : 'Offline' },
    error: { tone: 'err', label: 'Connection error' },
    idle: { tone: 'off', label: 'Offline' },
  }
  const m = meta[conn]
  return (
    <footer className="statusbar">
      <span className="statusbar__app">Moch</span>
      <span className="statusbar__conn">
        <span className={`statusbar__dot statusbar__dot--${m.tone}`} aria-hidden />
        {m.label}
      </span>
      <span className="statusbar__spring" />
      <span className="statusbar__hint">
        <kbd>Ctrl</kbd>
        <kbd>K</kbd> command palette
      </span>
    </footer>
  )
}
