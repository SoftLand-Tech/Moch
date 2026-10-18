import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { connectionState, isConnected, runtimeBoot, startGateway, wireEvents } from './lib/gateway'
import { hookChatEvents, loadMarks, refreshSessionOrder } from './lib/chat'
import { loadActiveBot, refreshFleet } from './lib/fleet'
import { useKnocks } from './lib/knocks'
import { ensureBrowserReady, ensureBrowserWatch } from './lib/cdp'
import BotsRail from './components/BotsRail'
import ContextPanel from './components/ContextPanel'
import ThreadHeader from './components/ThreadHeader'
import ChatView from './views/ChatView'
import FleetView from './views/FleetView'
import CrewView from './views/CrewView'
import InboxView from './views/InboxView'
import BrowserView from './views/BrowserView'
import TerminalView from './views/TerminalView'
import AutomationsView from './views/AutomationsView'
import SkillsView from './views/SkillsView'
import ConnectorsView from './views/ConnectorsView'
import SettingsView from './views/SettingsView'
import HistoryView from './views/HistoryView'
import ToolsView from './views/ToolsView'
import WorkflowsView from './views/WorkflowsView'
import CommandPalette from './components/CommandPalette'
import Mochi from './components/Mochi'
import { tr } from './lib/strings'

export type ViewId = 'chat' | 'fleet' | 'crew' | 'inbox' | 'browser' | 'terminal' | 'automations' | 'skills' | 'connectors' | 'settings' | 'history' | 'tools' | 'workflows'

export const activeView = { current: 'chat' as ViewId }

export function App() {
  const [view, setView] = useState<ViewId>('chat')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const connected = useStore(isConnected)
  const boot = useStore(runtimeBoot)
  const conn = useStore(connectionState)

  activeView.current = view

  useKnocks()

  // Boot the runtime + wire protocol exactly once.
  useEffect(() => {
    loadMarks()
    loadActiveBot()
    const stopEvents = wireEvents()
    const stopChat = hookChatEvents()
    void startGateway()
    return () => { stopEvents(); stopChat() }
  }, [])

  // Cross-view navigation + workbench events.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as ViewId | undefined
      if (detail) setView(detail)
    }
    window.addEventListener('moch-navigate', onNav)
    window.addEventListener('moch-workbench', onNav as EventListener)
    return () => {
      window.removeEventListener('moch-navigate', onNav)
      window.removeEventListener('moch-workbench', onNav as EventListener)
    }
  }, [])

  // Once connected: roster, sessions, and the agent browser ready+armed.
  useEffect(() => {
    if (connected) {
      void refreshFleet()
      void refreshSessionOrder()
      ensureBrowserWatch()
      void ensureBrowserReady()
    }
  }, [connected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); return }
      if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); setView('inbox'); return }
      if (mod && /^[1-9]$/.test(e.key)) {
        const order: ViewId[] = ['chat', 'fleet', 'crew', 'inbox', 'browser', 'terminal', 'automations', 'skills', 'connectors']
        const next = order[Number(e.key) - 1]
        if (next) { e.preventDefault(); setView(next) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.getElementById('boot-splash')?.remove()
  }, [])

  return (
    <div className="rk3">
      <BotsRail onNav={setView} />
      <main className="rk3-center">
        {boot.phase !== 'ready' ? (
          <BootVeil boot={boot} conn={conn} />
        ) : (
          <>
            {view === 'chat' ? <ThreadHeader /> : null}
            <div className="rk3-view">
              {view === 'chat' && <ChatView />}
              {view === 'fleet' && <FleetView onOpenChat={() => setView('chat')} />}
              {view === 'crew' && <CrewView />}
              {view === 'inbox' && <InboxView />}
              {view === 'browser' && <BrowserView />}
              {view === 'terminal' && <TerminalView />}
              {view === 'automations' && <AutomationsView />}
              {view === 'skills' && <SkillsView />}
              {view === 'connectors' && <ConnectorsView />}
              {view === 'settings' && <SettingsView onOpenView={setView} />}
              {view === 'history' && <HistoryView onOpen={setView} />}
              {view === 'tools' && <ToolsView onOpen={setView} />}
              {view === 'workflows' && <WorkflowsView onOpen={setView} />}
            </div>
          </>
        )}
      </main>
      <ContextPanel />

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNavigate={(v) => { setView(v); setPaletteOpen(false) }}
        />
      )}
    </div>
  )
}

function BootVeil({ boot, conn }: { boot: { phase: string; message: string }; conn: string }) {
  return (
    <div className="focus">
      <div className="empty">
        {boot.phase === 'error' ? (
          <>
            <div className="empty-title">{tr('boot.error.title')}</div>
            <div className="empty-sub">{boot.message}</div>
            <button className="btn primary" onClick={() => location.reload()}>{tr('boot.retry')}</button>
          </>
        ) : (
          <>
            <Mochi mood="connecting" size={84} />
            <div className="empty-title">{boot.message}</div>
            <div className="empty-sub">{tr('boot.local')}</div>
            {conn === 'connecting' ? <div className="text-faint" style={{ fontSize: 12 }}>{tr('boot.connecting')}</div> : null}
          </>
        )}
      </div>
    </div>
  )
}
