import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import {
  Bot, BotMessageSquare, CalendarClock, CircleCheck, Globe, Inbox, MessageSquareText,
  Plug, Settings, Sparkles, SquareTerminal, UsersRound,
} from 'lucide-react'
import { connectionState, gatewayInfo, isConnected, runtimeBoot, startGateway, wireEvents } from './lib/gateway'
import { hookChatEvents, pendingCount, loadMarks, refreshSessionOrder } from './lib/chat'
import { activeBotAtom, fleetProfiles, loadActiveBot, refreshFleet } from './lib/fleet'
import { useKnocks } from './lib/knocks'
import { locale, tr } from './lib/strings'
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
import StagePane from './components/StagePane'
import StatusBar from './components/StatusBar'
import CommandPalette from './components/CommandPalette'
import Mochi from './components/Mochi'

export type ViewId = 'chat' | 'fleet' | 'crew' | 'inbox' | 'browser' | 'terminal' | 'automations' | 'skills' | 'connectors' | 'settings'

export const activeView = { current: 'chat' as ViewId }

export function App() {
  const [view, setView] = useState<ViewId>('chat')
  const [stageOpen, setStageOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const connected = useStore(isConnected)
  const boot = useStore(runtimeBoot)
  const pending = useStore(pendingCount)
  const bots = useStore(fleetProfiles)
  const bot = useStore(activeBotAtom)
  const info = useStore(gatewayInfo)
  const conn = useStore(connectionState)
  useStore(locale) // subscribe so rail labels re-render when the language changes

  activeView.current = view

  // Cron knocks: poll automations while the app is open, notify on outcomes.
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

  // Once connected: load roster + sessions.
  useEffect(() => {
    if (connected) {
      void refreshFleet()
      void refreshSessionOrder()
    }
  }, [connected])

  // A pending interactive request jumps the user to the inbox if they're
  // elsewhere... actually the card renders inline in chat; the badge just
  // signals. Don't yank the user around on desktop.

  // Cross-view navigation events (e.g. Fleet → chat).
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as ViewId | undefined
      if (detail) setView(detail)
    }
    window.addEventListener('moch-navigate', onNav)
    return () => window.removeEventListener('moch-navigate', onNav)
  }, [])

  // Global keys: Cmd/Ctrl+K palette, Cmd+1..9 views, Cmd+Enter send is local.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setView('inbox')
        return
      }
      if (mod && /^[1-9]$/.test(e.key)) {
        const order: ViewId[] = ['chat', 'fleet', 'crew', 'inbox', 'browser', 'terminal', 'automations', 'skills', 'connectors']
        const next = order[Number(e.key) - 1]
        if (next) {
          e.preventDefault()
          setView(next)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Hide the boot splash once React owns the screen.
  useEffect(() => {
    const splash = document.getElementById('boot-splash')
    if (splash) splash.remove()
    const msg = document.getElementById('boot-msg')
    if (msg) msg.remove()
  }, [])

  const navItems: { id: ViewId; icon: typeof Bot; label: string; badge?: number }[] = [
    { id: 'chat', icon: MessageSquareText, label: tr('nav.chats') },
    { id: 'fleet', icon: Bot, label: tr('nav.fleet') },
    { id: 'crew', icon: UsersRound, label: tr('nav.crew') },
    { id: 'inbox', icon: Inbox, label: tr('nav.inbox'), badge: pending || undefined },
    { id: 'browser', icon: Globe, label: tr('nav.browser') },
    { id: 'terminal', icon: SquareTerminal, label: tr('nav.terminal') },
    { id: 'automations', icon: CalendarClock, label: tr('nav.automations') },
    { id: 'skills', icon: Sparkles, label: tr('nav.skills') },
    { id: 'connectors', icon: Plug, label: tr('nav.connectors') },
  ]

  const fullStageViews: ViewId[] = ['browser', 'terminal']

  return (
    <div className="shell">
      <div className={`shell-main${stageOpen && !fullStageViews.includes(view) ? ' with-stage' : ''}`}>
        <nav className="rail" aria-label="Primary">
          <div className="rail-logo" title="Moch">
            <BotMessageSquare size={20} color="var(--accent)" strokeWidth={2.2} />
          </div>
          {navItems.map(({ id, icon: Icon, label, badge }, idx) => (
            <button
              key={id}
              className={`rail-btn${view === id ? ' active' : ''}`}
              onClick={() => setView(id)}
              title={`${label} — Ctrl+${idx + 1 <= 9 ? idx + 1 : '·'}`}
              aria-label={label}
            >
              <Icon size={19} strokeWidth={1.9} />
              {badge ? <span className="badge">{badge > 9 ? '9+' : badge}</span> : null}
            </button>
          ))}
          <div className="rail-spacer" />
          <button
            className={`rail-btn${view === 'settings' ? ' active' : ''}`}
            onClick={() => setView('settings')}
            title={tr('nav.settings')}
            aria-label={tr('nav.settings')}
          >
            <Settings size={19} strokeWidth={1.9} />
          </button>
        </nav>

        {boot.phase !== 'ready' ? (
          <BootVeil boot={boot} conn={conn} />
        ) : (
          <>
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

            {stageOpen && !fullStageViews.includes(view) && (
              <StagePane onClose={() => setStageOpen(false)} />
            )}
          </>
        )}
      </div>
      <StatusBar
        connected={connected}
        port={info?.port ?? null}
        botCount={bots.length}
        activeBot={bot}
        onToggleStage={() => setStageOpen((v) => !v)}
        stageOpen={stageOpen || fullStageViews.includes(view)}
        onOpenPalette={() => setPaletteOpen(true)}
      />
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
    <div className="focus" style={{ gridColumn: '2 / -1' }}>
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
