/** Moch Desktop — dedicated app root. Owns the shell chrome and the
 * screen registry; each screen is a worker-built surface over the shared
 * engine. */
import React, { Suspense, useCallback, useEffect, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  bootDesktop,
  connConfig,
  connectionState,
  everConnected,
} from './core/boot'
import { installTheme } from './ui/shell/themeVars'
import { Shell } from './ui/shell/Shell'
import { installAccelerators, installTauriMenuBridge } from './ui/shell/accelerators'
import { setShellLayout, shellLayout, type ScreenId } from './ui/shell/state'
import { SCREENS, SCREEN_ICONS } from './ui/shell/registry'
import { sessionRows, loadSessions } from '../../../app/src/lib/sessionList'
import { newChat, stopRun } from '../../../app/src/lib/chat'

const LazyChat = React.lazy(() => import('./ui/Chat').then((m) => ({ default: m.Chat })))
const LazySessions = React.lazy(() => import('./ui/Sessions'))
const LazyBrowser = React.lazy(() => import('./ui/Browser').then((m) => ({ default: m.Browser })))
const LazyAutomations = React.lazy(() => import('./ui/Automations'))
const LazyFleet = React.lazy(() => import('./ui/Fleet'))
const LazySkills = React.lazy(() => import('./ui/Skills'))
const LazyConnectors = React.lazy(() => import('./ui/Connectors'))
const LazyTerminal = React.lazy(() => import('./ui/Terminal').then((m) => ({ default: m.TerminalScreen })))
const LazyModels = React.lazy(() => import('./ui/Models'))
const LazySettings = React.lazy(() => import('./ui/Settings'))

function Placeholder(props: { screen: ScreenId }): React.JSX.Element {
  const meta = SCREENS.find((s) => s.id === props.screen)
  const Icon = SCREEN_ICONS[props.screen]
  return (
    <div className="screen" style={{ padding: 24 }}>
      <h2 className="screen-title">
        <Icon size={18} /> {meta?.label ?? props.screen}
      </h2>
      <p className="screen-empty">This surface is being built and lands in the next integration pass.</p>
    </div>
  )
}

function SessionsList(props: { onOpen: (id: string) => void }): React.JSX.Element {
  const rows = useStore(sessionRows)
  return (
    <div className="screen" style={{ padding: 0 }}>
      <div className="pane-header-row">
        <span className="screen-empty">CHATS</span>
        <button className="btn" onClick={() => void newChat()} aria-label="New chat">
          + New
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="screen-empty" style={{ padding: '0 12px' }}>
          No conversations yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.id}>
              <button
                className="session-row"
                onClick={() => {
                  void import('./ui/Chat/api').then((m) => m.openSessionById(r.id))
                  props.onOpen(r.id)
                }}
              >
                {r.title || 'New chat'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function useOnline(): boolean {
  const state = useStore(connectionState)
  const ever = useStore(everConnected)
  return ever || state === 'open'
}

export function App(): React.JSX.Element {
  const connected = useOnline()
  const cfg = useStore(connConfig)
  const layout = useStore(shellLayout)
  const screen = layout.screen

  useEffect(() => installTheme(), [])
  useEffect(() => {
    if (connected) void loadSessions()
  }, [connected])

  const focusScreen = useCallback((id: ScreenId) => {
    setShellLayout({ screen: id })
  }, [])
  const doNewChat = useCallback(() => {
    focusScreen('chat')
    void newChat()
  }, [focusScreen])
  const doStop = useCallback(() => {
    void stopRun()
  }, [])

  useEffect(() => {
    return installAccelerators({ newChat: doNewChat, stopRun: doStop, focusScreen })
  }, [doNewChat, doStop, focusScreen])
  useEffect(() => {
    return installTauriMenuBridge({ newChat: doNewChat, stopRun: doStop, focusScreen })
  }, [doNewChat, doStop, focusScreen])

  const views: Partial<Record<ScreenId, React.ReactNode>> = {
    chat: (
      <Suspense fallback={<Placeholder screen="chat" />}>
        <LazyChat />
      </Suspense>
    ),
    sessions: (
      <Suspense fallback={<Placeholder screen="sessions" />}>
        <LazySessions />
      </Suspense>
    ),
    automations: (
      <Suspense fallback={<Placeholder screen="automations" />}>
        <LazyAutomations />
      </Suspense>
    ),
    fleet: (
      <Suspense fallback={<Placeholder screen="fleet" />}>
        <LazyFleet />
      </Suspense>
    ),
    skills: (
      <Suspense fallback={<Placeholder screen="skills" />}>
        <LazySkills />
      </Suspense>
    ),
    connectors: (
      <Suspense fallback={<Placeholder screen="connectors" />}>
        <LazyConnectors />
      </Suspense>
    ),
    browser: (
      <Suspense fallback={<Placeholder screen="browser" />}>
        <LazyBrowser />
      </Suspense>
    ),
    terminal: (
      <Suspense fallback={<Placeholder screen="terminal" />}>
        <LazyTerminal />
      </Suspense>
    ),
    agent: (
      <Suspense fallback={<Placeholder screen="agent" />}>
        <LazyModels />
      </Suspense>
    ),
    settings: (
      <Suspense fallback={<Placeholder screen="settings" />}>
        <LazySettings />
      </Suspense>
    ),
  }

  const openChatDraft = useCallback(
    (draft: string) => {
      focusScreen('chat')
      void import('./core/openSession').then((m) => m.setComposerDraft(draft)).catch(() => {})
    },
    [focusScreen],
  )

  return (
    <Shell
      active={screen}
      mode={layout.mode}
      list={screen === 'chat' ? <SessionsList onOpen={(id) => focusScreen('chat')} /> : undefined}
      onNavigate={focusScreen}
      onOpenChatDraft={openChatDraft}
    >
      {!connected ? (
        <div className="screen" style={{ padding: 24 }}>
          <h2 className="screen-title">{cfg ? 'Connecting to your computer…' : 'Not paired'}</h2>
          <p className="screen-empty">
            {cfg
              ? 'The supervised gateway is starting. This takes a few seconds on a cold boot.'
              : 'Pair a computer from Settings to begin.'}
          </p>
        </div>
      ) : (
        (views[screen] ?? <Placeholder screen={screen} />)
      )}
    </Shell>
  )
}
