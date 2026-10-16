import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { Bot, BotMessageSquare, CalendarClock, Globe, Inbox, MessageSquareText,
  Plug, Sparkles, SquareTerminal, UsersRound, History,
} from 'lucide-react'
import { connectionState, gatewayInfo, isConnected, runtimeBoot, startGateway, wireEvents } from './lib/gateway'
import { hookChatEvents, pendingCount, loadMarks, refreshSessionOrder } from './lib/chat'
import { activeBotAtom, fleetProfiles, loadActiveBot, refreshFleet } from './lib/fleet'
import { useKnocks } from './lib/knocks'
import { ensureBrowserReady, ensureBrowserWatch } from './lib/cdp'
import Titlebar from './components/Titlebar'
import TaskSidebar from './components/TaskSidebar'
import WorkbenchPanel from './components/WorkbenchPanel'
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

export type ViewId = 'chat' | 'fleet' | 'crew' | 'inbox' | 'browser' | 'terminal' | 'automations' | 'skills' | 'connectors' | 'settings' | 'history' | 'tools' | 'workflows'

export const activeView = { current: 'chat' as ViewId }

export function App() {
  const [view, setView] = useState<ViewId>('chat')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const connected = useStore(isConnected)
  const boot = useStore(runtimeBoot)
  const bots = useStore(fleetProfiles)
  const info = useStore(gatewayInfo)
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

  const navItems: { id: ViewId; icon: typeof Bot; label: string }[] = [
    { id: 'chat', icon: MessageSquareText, label: 'Home' },
    { id: 'fleet', icon: Bot, label: 'Agents' },
    { id: 'skills', icon: Sparkles, label: 'Tools' },
    { id: 'workflows', icon: CalendarClock, label: 'Workflows' },
    { id: 'history', icon: History, label: 'History' },
  ]
  const moreItems: { id: ViewId; icon: typeof Bot; label: string }[] = [
    { id: 'inbox', icon: Inbox, label: 'Inbox' },
    { id: 'crew', icon: UsersRound, label: 'Crew' },
    { id: 'connectors', icon: Plug, label: 'Connectors' },
    { id: 'terminal', icon: SquareTerminal, label: 'Terminal' },
    { id: 'browser', icon: Globe, label: 'Browser' },
  ]

  const workbenchOpen = view === 'chat'

  return (
    <div className="shell2">
      <Titlebar
        onSearch={() => setPaletteOpen(true)}
        onSettings={() => setView('settings')}
      />
      <div className="shell2-body">
        <TaskSidebar view={view} onNav={setView} />
        <div className="shell2-main">
          {boot.phase !== 'ready' ? (
            <BootVeil boot={boot} conn={conn} />
          ) : (
            <div className={`viewrow${workbenchOpen ? ' with-wb' : ''}`}>
              <div className="viewwrap">
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
              {workbenchOpen ? <WorkbenchPanel /> : null}
            </div>
          )}
        </div>
      </div>

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
            <div className="empty-title">The local runtime hit a problem</div>
            <div className="empty-sub">{boot.message}</div>
            <button className="btn primary" onClick={() => location.reload()}>Retry</button>
          </>
        ) : (
          <>
            <Mochi mood="connecting" size={84} />
            <div className="empty-title">{boot.message}</div>
            <div className="empty-sub">The hermes agents, your bots and everything else live right here on this machine — nothing leaves it.</div>
            {conn === 'connecting' ? <div className="text-faint" style={{ fontSize: 12 }}>connecting to the gateway…</div> : null}
          </>
        )}
      </div>
    </div>
  )
}
