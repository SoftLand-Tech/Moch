/**
 * Moch Desktop — 3-Column AI Agent Dashboard:
 * - Left Navigation Sidebar (Brand, Primary Tabs, Workspace Modes, Mascot Profile)
 * - Top Bar (Window dots, Search, Notifications, Right Panel Toggle, User Avatar)
 * - Center Workspace Canvas (Chat/Agent with Hero Empty State, Example Tasks, Streaming Messages)
 * - Right Activity Panel (Live Task Progress & Steps Checklist, Activity Feed, Tools & Integrations)
 */
import { useEffect, useRef, useState } from 'react'
import { JsonRpcGatewayClient } from '../../../app/src/protocol/json-rpc-gateway'
import {
  IconAgent,
  IconAgents,
  IconBell,
  IconChat,
  IconCoding,
  IconFiles,
  IconHome,
  IconLayout,
  IconProjects,
  IconResearch,
  IconSearch,
  IconSettings,
  IconTools,
} from './Icons'
import RightPanel, { type ActiveTaskState, type ActivityItem } from './RightPanel'
import { dbg, ev, type Cfg, type LaunchSkill, type Tab } from './types'
import AutomationsTab from './tabs/Automations'
import BotsTab from './tabs/Bots'
import ChatTab from './tabs/Chat'
import CrewTab from './tabs/Crew'
import ModelsTab from './tabs/Models'
import RunTab from './tabs/Run'
import SkillsTab from './tabs/Skills'
import Wizard from './tabs/Wizard'

export type WorkspaceMode = 'agent' | 'chat' | 'coding' | 'research'

export default function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting')
  const [tab, setTab] = useState<Tab>('chat')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('agent')
  const [chatProfile, setChatProfile] = useState('')
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
  const [rightPanelOpen, setRightPanelOpen] = useState(true)
  const [agentWorking, setAgentWorking] = useState(false)
  const [activeTask, setActiveTask] = useState<ActiveTaskState | null>(null)
  const [activityEvents, setActivityEvents] = useState<ActivityItem[]>([])
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)

  const clientRef = useRef<JsonRpcGatewayClient | null>(null)
  const rpcRef = useRef<(<T = unknown>(m: string, p?: Record<string, unknown>) => Promise<T>) | null>(null)
  const urlRef = useRef('')

  const [client, setClient] = useState<JsonRpcGatewayClient | null>(null)
  const selftestRan = useRef(false)

  // Boot + reconnect supervisor
  useEffect(() => {
    let closed = false
    let timer: number | undefined
    let watchdog: number | undefined
    let poll: number | undefined
    let attempt = 0
    let everOpened = false

    const dial = () => {
      if (closed) return
      const url = urlRef.current
      if (!url) return
      setConn('connecting')
      const c = new JsonRpcGatewayClient({
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 120_000,
        socketFactory: (u: string) => new WebSocket(u) as unknown as WebSocket,
      })
      clientRef.current = c
      rpcRef.current = <T = unknown>(m: string, p?: Record<string, unknown>) => c.request(m, p) as Promise<T>

      c.onAny((e) => {
        const { type } = ev(e)
        if (type === 'gateway.ready') {
          attempt = 0
          setConn('open')
          setClient(c)
          dbg(everOpened ? 'ws-reconnected' : 'ws-open', {})
          everOpened = true
        }
      })

      c.connect(url).catch(() => {})
      clearTimeout(watchdog)
      watchdog = window.setTimeout(() => {
        if (!closed && c.connectionState !== 'open') {
          try { c.close() } catch { }
          schedule()
        }
      }, 20_000)
    }

    const schedule = () => {
      if (closed) return
      const delay = everOpened
        ? Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4))
        : Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 3))
      attempt++
      timer = window.setTimeout(dial, delay)
    }

    ;(async () => {
      let c: Cfg
      try {
        c = await (await fetch('/moch-config.json')).json()
      } catch {
        setConn('error')
        return
      }
      setCfg(c)
      dbg('cfg', { mode: c.mode })
      if (c.mode === 'error') {
        setConn('error')
        return
      }
      urlRef.current = `${c.wsUrl}?token=${encodeURIComponent(c.token)}`
      dial()
      poll = window.setInterval(() => {
        const cl = clientRef.current
        if (cl && everOpened && cl.connectionState === 'closed') {
          dbg('ws-drop', {})
          schedule()
        }
      }, 3_000)
    })()

    return () => {
      closed = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      clearInterval(poll)
      clientRef.current?.close()
    }
  }, [])

  // Load skills for Tools tab & quick picker
  useEffect(() => {
    if (conn !== 'open' || !rpcRef.current) return
    rpcRef.current<{ skills?: LaunchSkill[] }>('moch.skills.list')
      .then((res) => {
        if (res?.skills && Array.isArray(res.skills)) setSkills(res.skills)
      })
      .catch(() => {})
  }, [conn])

  // First-run gate
  useEffect(() => {
    fetch('/setup.json')
      .then((r) => r.json())
      .then((s) => setSetupDone(!!s.done))
      .catch(() => setSetupDone(false))
  }, [])

  // Selftest
  useEffect(() => {
    if (conn !== 'open' || !location.search.includes('selftest=1')) return
    if (selftestRan.current) return
    selftestRan.current = true
    ;(async () => {
      const r = rpcRef.current
      if (!r) return
      const try_ = async (what: string, m: string, p: Record<string, unknown> = {}) => {
        try {
          const res = await r(m, p)
          dbg(`selftest:${what}`, { ok: true, n: Array.isArray(res) ? res.length : Object.keys(res ?? {}).length })
        } catch (e) {
          dbg(`selftest:${what}`, { ok: false, err: String(e).slice(0, 140) })
        }
      }
      await try_('sessions', 'session.list', { limit: 200 })
      await try_('profiles', 'profiles.list', {})
      await try_('fleet', 'moch.fleet.status', {})
      await try_('skills', 'moch.skills.list', {})
      await try_('cron', 'cron.manage', { action: 'list', include_disabled: true })
      await try_('kanban', 'moch.kanban.tasks', { limit: 120 })
      await try_('models', 'model.options', { include_unconfigured: true })
      try {
        const cr = await r<{ session_id: string }>('session.create', { title: 'selftest', cols: 120, source: 'mobile' })
        await r('prompt.submit', { session_id: cr.session_id, text: 'Reply with the single word READY and nothing else.' })
        dbg('selftest:submitted', {})
      } catch (e) {
        dbg('selftest:chat-error', { err: String(e).slice(0, 140) })
      }
    })()
  }, [conn])

  if (setupDone === null) {
    return (
      <div className="wizard">
        <img className="mochi-img" src="/brand/mochi-connecting.svg" alt="Mochi" />
        <p className="dim">Moch</p>
      </div>
    )
  }
  if (!setupDone) {
    return <Wizard conn={conn} cfg={cfg} rpc={rpcRef} onDone={() => setSetupDone(true)} />
  }

  const handleActivity = (item: ActivityItem) => {
    setActivityEvents((prev) => [item, ...prev.slice(0, 24)])
  }

  const handleModeSelect = (m: WorkspaceMode) => {
    setWorkspaceMode(m)
    setTab('chat')
  }

  return (
    <div className="app-shell">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="window-dots">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>

        <div className="topbar-search">
          <IconSearch width={14} height={14} className="search-icon" />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="topbar-actions">
          <button
            className={`topbar-icon-btn ${notificationsOpen ? 'active' : ''}`}
            title="Notifications / Activity"
            onClick={() => setNotificationsOpen((v) => !v)}
          >
            <IconBell width={16} height={16} />
            <span className="badge-dot" />
          </button>

          <button
            className={`topbar-icon-btn ${rightPanelOpen ? 'active' : ''}`}
            title="Toggle Right Panel"
            onClick={() => setRightPanelOpen((v) => !v)}
          >
            <IconLayout width={16} height={16} />
          </button>

          <div className="user-profile-avatar" title="Mamoun Hisham">
            <span>MH</span>
          </div>
        </div>
      </header>

      {/* Notifications Popover */}
      {notificationsOpen && (
        <div className="notifications-popover">
          <div className="notif-head">
            <span>Runtime Activity & Knocks</span>
            <button className="notif-close" onClick={() => setNotificationsOpen(false)}>✕</button>
          </div>
          <div className="notif-body">
            <div className="notif-item">
              <span className="notif-dot ok" />
              <div>
                <strong>Gateway connected</strong>
                <p>Loopback runtime accepting on 127.0.0.1:9118</p>
              </div>
            </div>
            <div className="notif-item">
              <span className="notif-dot ok" />
              <div>
                <strong>Cron ticker active</strong>
                <p>HERMES_DESKTOP=1 ticker armed</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Main App Body (3 Columns) ── */}
      <div className="app-body">
        {/* ── Left Sidebar (230px) ── */}
        <aside className="sidebar">
          {/* Brand header */}
          <div className="sidebar-brand">
            <img className="sidebar-logo-img" src="/brand/logo.png" alt="Moch" />
            <div className="sidebar-brand-text">
              <h3>Moch</h3>
              <p>Your Hermes AI Agent</p>
            </div>
          </div>

          {/* Primary Navigation */}
          <nav className="nav-group">
            <button
              className={`nav-item ${tab === 'chat' ? 'active' : ''}`}
              onClick={() => setTab('chat')}
            >
              <IconHome width={17} height={17} />
              <span>Home</span>
            </button>
            <button
              className={`nav-item ${tab === 'bots' ? 'active' : ''}`}
              onClick={() => setTab('bots')}
            >
              <IconAgents width={17} height={17} />
              <span>Agents</span>
            </button>
            <button
              className={`nav-item ${tab === 'crew' ? 'active' : ''}`}
              onClick={() => setTab('crew')}
            >
              <IconProjects width={17} height={17} />
              <span>Projects</span>
            </button>
            <button
              className={`nav-item ${tab === 'run' ? 'active' : ''}`}
              onClick={() => setTab('run')}
            >
              <IconFiles width={17} height={17} />
              <span>Files</span>
            </button>
            <button
              className={`nav-item ${tab === 'skills' ? 'active' : ''}`}
              onClick={() => setTab('skills')}
            >
              <IconTools width={17} height={17} />
              <span>Tools</span>
            </button>
            <button
              className={`nav-item ${tab === 'models' ? 'active' : ''}`}
              onClick={() => setTab('models')}
            >
              <IconSettings width={17} height={17} />
              <span>Settings</span>
            </button>
          </nav>

          {/* Workspace Modes */}
          <div className="workspace-modes-section">
            <div className="modes-label">WORKSPACE MODES</div>
            <div className="modes-list">
              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'chat' ? 'active' : ''}`}
                onClick={() => handleModeSelect('chat')}
              >
                <div className="mode-card-icon"><IconChat width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Chat</strong>
                  <p>Just talk, get things done</p>
                </div>
              </button>

              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'agent' ? 'active' : ''}`}
                onClick={() => handleModeSelect('agent')}
              >
                <div className="mode-card-icon purple"><IconAgent width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Agent</strong>
                  <p>Autonomous tasks & tools</p>
                </div>
              </button>

              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'coding' ? 'active' : ''}`}
                onClick={() => handleModeSelect('coding')}
              >
                <div className="mode-card-icon blue"><IconCoding width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Coding</strong>
                  <p>Code, terminal, dev tools</p>
                </div>
              </button>

              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'research' ? 'active' : ''}`}
                onClick={() => handleModeSelect('research')}
              >
                <div className="mode-card-icon cyan"><IconResearch width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Research</strong>
                  <p>Deep research & analysis</p>
                </div>
              </button>
            </div>
          </div>

          {/* Bottom Profile Card */}
          <div className="sidebar-profile-card">
            <img className="profile-mascot-avatar" src="/brand/icon.png" alt="Mochi" />
            <div className="profile-card-info">
              <span className="profile-name">Moch</span>
              <span className="profile-tagline">Always here, always working.</span>
              <span className="profile-status-pill">
                <span className={`status-dot ${conn === 'open' ? 'online' : 'offline'}`} />
                {conn === 'open' ? 'Online' : 'Connecting...'}
              </span>
            </div>
          </div>
        </aside>

        {/* ── Center Main Workspace ── */}
        <main className="center-workspace">
          {conn === 'error' ? (
            <div className="fatal">
              <img className="mochi-img" src="/brand/mochi-offline.svg" alt="Mochi" />
              <p>No local runtime found.</p>
              <p className="hint">Check <code>desktop/.hermes-serve.log</code> — the shell tried port 9118 and 9119.</p>
            </div>
          ) : (
            <>
              {tab === 'chat' && (
                <ChatTab
                  rpc={rpcRef}
                  client={client}
                  profile={chatProfile}
                  onProfile={setChatProfile}
                  mode={workspaceMode}
                  onActivity={handleActivity}
                  onTaskUpdate={setActiveTask}
                  onWorkingChange={setAgentWorking}
                />
              )}
              {tab === 'bots' && <BotsTab rpc={rpcRef} onChat={(name) => { setChatProfile(name); setTab('chat') }} />}
              {tab === 'crew' && <CrewTab rpc={rpcRef} />}
              {tab === 'automations' && <AutomationsTab rpc={rpcRef} />}
              {tab === 'skills' && <SkillsTab rpc={rpcRef} />}
              {tab === 'models' && <ModelsTab rpc={rpcRef} />}
              {tab === 'run' && <RunTab cfg={cfg} rpc={rpcRef} />}
            </>
          )}
        </main>

        {/* ── Right Panel (Collapsible Inspector) ── */}
        <RightPanel
          open={rightPanelOpen}
          agentWorking={agentWorking}
          activeTask={activeTask}
          activityEvents={activityEvents}
          skills={skills}
          logTail={cfg?.logTail}
          onViewAllTools={() => setTab('skills')}
        />
      </div>
    </div>
  )
}
