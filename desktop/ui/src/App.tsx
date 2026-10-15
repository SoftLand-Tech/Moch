/**
 * Moch Desktop — 3-Column AI Agent Dashboard:
 * - Left Navigation Sidebar (Brand, Primary Tabs, Workspace Modes, Mascot Profile)
 * - Top Bar (Search, Runtime Notifications, Right Panel Toggle)
 * - Center Workspace Canvas (Chat/Agent with Hero Empty State, Example Tasks, Streaming Messages)
 * - Right Activity Panel (Live Task Progress & Steps Checklist, Activity Feed, Tools & Integrations)
 */
import { useEffect, useRef, useState } from 'react'
import { JsonRpcGatewayClient } from '../../../app/src/protocol/json-rpc-gateway'
import {
  IconAgent,
  IconAgents,
  IconBell,
  IconCalendar,
  IconChat,
  IconCoding,
  IconLayout,
  IconProjects,
  IconResearch,
  IconSearch,
  IconSettings,
  IconTerminal,
  IconTools,
} from './Icons'
import RightPanel, { type ActiveTaskState, type ActivityItem } from './RightPanel'
import { dbg, ev, type Cfg, type LaunchSkill, type Tab } from './types'
import AutomationsTab from './tabs/Automations'
import BrowserTab from './tabs/Browser'
import BotsTab from './tabs/Bots'
import ChatTab from './tabs/Chat'
import CrewTab from './tabs/Crew'
import ModelsTab from './tabs/Models'
import RunTab from './tabs/Run'
import SkillsTab from './tabs/Skills'
import Wizard from './tabs/Wizard'
import AsksOverlay, { addAsk, removeAsk } from './Asks'

export type WorkspaceMode = 'agent' | 'chat' | 'coding' | 'research'

/** One real runtime connection event, shown in the bell popover. */
type RuntimeEvent = { id: number; text: string; at: string }

export default function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting')
  const [tab, setTab] = useState<Tab>('chat')
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('agent')
  const [chatProfile, setChatProfile] = useState('')
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('moch.rightPanel') !== '0' } catch { return true }
  })
  const [agentWorking, setAgentWorking] = useState(false)
  const [activeTask, setActiveTask] = useState<ActiveTaskState | null>(null)
  const [activityEvents, setActivityEvents] = useState<ActivityItem[]>([])
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([])

  const clientRef = useRef<JsonRpcGatewayClient | null>(null)
  const rpcRef = useRef<(<T = unknown>(m: string, p?: Record<string, unknown>) => Promise<T>) | null>(null)
  const urlRef = useRef('')
  const runtimeEventSeq = useRef(0)
  const lastLoggedConn = useRef<'' | 'connecting' | 'open' | 'error'>('')

  const [client, setClient] = useState<JsonRpcGatewayClient | null>(null)
  const selftestRan = useRef(false)

  // Boot + reconnect supervisor. ONE persistent gateway client for the
  // app's lifetime: reconnect = connect() AGAIN on the same instance, so
  // per-session seq watermarks survive drops and the client's own replay
  // machinery re-delivers missed events + open requests after reopening.
  useEffect(() => {
    let closed = false
    let dialing = false // a dial is scheduled or connecting — blocks re-entry
    let timer: number | undefined
    let watchdog: number | undefined
    let poll: number | undefined
    let attempt = 0
    let everOpened = false

    const client = new JsonRpcGatewayClient({
      connectTimeoutMs: 15_000,
      requestTimeoutMs: 120_000,
      socketFactory: (u: string) => new WebSocket(u) as unknown as WebSocket,
    })
    clientRef.current = client
    rpcRef.current = <T = unknown>(m: string, p?: Record<string, unknown>) => client.request(m, p) as Promise<T>

    client.onAny((e) => {
      const gev = ev(e)
      // The backend withdrew an open server→client request (timeout /
      // interrupt / shutdown / resolved) — drop the matching card so a
      // settled id can never be answered late (payload {id, method, reason},
      // server_requests.py:126).
      if (gev.type === 'request.cancel') {
        const pl = gev.payload ?? {}
        const rid = typeof pl.id === 'string' ? pl.id : ''
        if (rid) removeAsk(rid)
        return
      }
      if (gev.type !== 'gateway.ready') return
      if (closed) return
      attempt = 0
      dialing = false
      clearTimeout(watchdog) // ready ⇒ the dial settled; drop the 20s net
      setConn('open')
      setClient(client)
      dbg(everOpened ? 'ws-reconnected' : 'ws-open', {})
      everOpened = true
    })

    // Server→client requests (approval / clarify / sudo / secret) are answered
    // HERE, at App level — the subscription must outlive ChatTab's conditional
    // mount, or a question arriving while the user browses another tab is
    // auto-declined -32601 by the channel. Cards live in the Asks store and
    // render as a fixed overlay visible on every tab (ui/src/Asks.tsx).
    const offRequests = client.onRequest((req) => {
      const method = String(req?.method ?? '')
      if (method !== 'approval' && method !== 'clarify' && method !== 'sudo' && method !== 'secret') {
        // Preserve the channel's default answer for anything not rendered here.
        req.fail(-32601, `no handler for server request: ${method}`)
        return true
      }
      if (!req.sessionId) return false // unaddressable: channel answers -32601 (phone BUG-067)
      const kind =
        method === 'approval' ? 'approval'
          : method === 'sudo' ? 'sudo'
          : method === 'secret' ? 'secret'
          : Array.isArray(req.params?.questions) ? 'batch_clarify'
          : 'clarify'
      addAsk({
        id: req.id,
        kind,
        session_id: req.sessionId,
        params: req.params ?? {},
        respond: req.respond,
        fail: req.fail,
      })
      return true
    })

    const dial = () => {
      if (closed || dialing) return
      const url = urlRef.current
      if (!url) return
      dialing = true
      setConn('connecting')
      client.connect(url).catch(() => {
        // Handshake failed (refused / auth gate / 15s timeout) — back off
        // now instead of sitting out the watchdog with a dead dial.
        clearTimeout(watchdog)
        if (closed || !dialing) return
        dialing = false
        schedule()
      })
      clearTimeout(watchdog)
      watchdog = window.setTimeout(() => {
        if (closed || !dialing) return
        if (client.connectionState === 'open') return
        try { client.close() } catch { } // never abandon a socket without close()
        dialing = false
        schedule()
      }, 20_000)
    }

    // Idempotent: a pending redial is cleared before a new one is set.
    const schedule = () => {
      if (closed) return
      clearTimeout(timer)
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
      if (closed) return // unmounted mid-fetch — don't touch refs/state
      setCfg(c)
      dbg('cfg', { mode: c.mode })
      if (c.mode === 'error') {
        setConn('error')
        return
      }
      urlRef.current = `${c.wsUrl}?token=${encodeURIComponent(c.token)}`
      dial()
      poll = window.setInterval(() => {
        if (closed || dialing || timer !== undefined) return
        if (everOpened && client.connectionState === 'closed') {
          dbg('ws-drop', {})
          setConn('connecting')
          setRuntimeEvents((p) => [{ id: ++runtimeEventSeq.current, text: 'Connection lost', at: new Date().toLocaleTimeString() }, ...p].slice(0, 25))
          schedule() // redial the SAME client → replay of missed seq'd events
        }
      }, 3_000)
    })()

    return () => {
      closed = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      clearInterval(poll)
      offRequests()
      client.close()
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

  // Real runtime event log for the bell popover (deduped via ref so
  // StrictMode's double-mount and re-runs don't push the same transition twice).
  useEffect(() => {
    if (lastLoggedConn.current === conn) return
    const prev = lastLoggedConn.current
    lastLoggedConn.current = conn
    // Skip the very first 'connecting' — nothing has transitioned yet.
    if (conn === 'open') {
      setRuntimeEvents((p) => [{ id: ++runtimeEventSeq.current, text: 'Connected to local runtime', at: new Date().toLocaleTimeString() }, ...p].slice(0, 25))
    } else if (conn === 'error') {
      setRuntimeEvents((p) => [{ id: ++runtimeEventSeq.current, text: 'Connection lost', at: new Date().toLocaleTimeString() }, ...p].slice(0, 25))
    } else if (conn === 'connecting' && prev !== '') {
      setRuntimeEvents((p) => [{ id: ++runtimeEventSeq.current, text: 'Reconnecting…', at: new Date().toLocaleTimeString() }, ...p].slice(0, 25))
    }
  }, [conn])

  // Close the notifications popover on Escape.
  useEffect(() => {
    if (!notificationsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotificationsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notificationsOpen])

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

  const toggleRightPanel = () => {
    setRightPanelOpen((v) => {
      const next = !v
      try { localStorage.setItem('moch.rightPanel', next ? '1' : '0') } catch { /* private mode etc. */ }
      return next
    })
  }

  return (
    <div className="app-shell">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="topbar-search">
          <IconSearch width={14} height={14} className="search-icon" />
          <input
            type="text"
            placeholder="Search chats…"
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
            {conn !== 'open' && <span className="badge-dot" />}
          </button>

          <button
            className={`topbar-icon-btn ${rightPanelOpen ? 'active' : ''}`}
            title="Toggle Right Panel"
            onClick={toggleRightPanel}
          >
            <IconLayout width={16} height={16} />
          </button>
        </div>
      </header>

      {/* Notifications Popover — outside-click backdrop (popover itself is z-index 100) */}
      {notificationsOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'transparent', zIndex: 99 }}
          onClick={() => setNotificationsOpen(false)}
        />
      )}
      {notificationsOpen && (
        <div className="notifications-popover">
          <div className="notif-head">
            <span>Runtime Activity</span>
            <button className="notif-close" onClick={() => setNotificationsOpen(false)}>✕</button>
          </div>
          <div className="notif-body">
            {runtimeEvents.length === 0 ? (
              <div className="notif-item">
                <div><p>No runtime events yet.</p></div>
              </div>
            ) : (
              runtimeEvents.map((e) => (
                <div className="notif-item" key={e.id}>
                  <span className="notif-dot ok" />
                  <div>
                    <strong>{e.text}</strong>
                    <p>{e.at}</p>
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border, rgba(128,128,128,0.2))' }}>
            <button
              onClick={() => { setNotificationsOpen(false); setTab('run') }}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-faint, inherit)', fontSize: 11 }}
            >
              Details in the Runtime tab →
            </button>
          </div>
        </div>
      )}

      {/* Global ask-card overlay — server→client requests (approval / clarify
          / sudo / secret), visible on EVERY tab. Renders null when empty. */}
      <AsksOverlay />

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
              <IconChat width={17} height={17} />
              <span>Chat</span>
            </button>
            <button
              className={`nav-item ${tab === 'bots' ? 'active' : ''}`}
              onClick={() => setTab('bots')}
            >
              <IconAgents width={17} height={17} />
              <span>Bots</span>
            </button>
            <button
              className={`nav-item ${tab === 'crew' ? 'active' : ''}`}
              onClick={() => setTab('crew')}
            >
              <IconProjects width={17} height={17} />
              <span>Crew</span>
            </button>
            <button
              className={`nav-item ${tab === 'automations' ? 'active' : ''}`}
              onClick={() => setTab('automations')}
            >
              <IconCalendar width={17} height={17} />
              <span>Automations</span>
            </button>
            <button
              className={`nav-item ${tab === 'skills' ? 'active' : ''}`}
              onClick={() => setTab('skills')}
            >
              <IconTools width={17} height={17} />
              <span>Skills</span>
            </button>
            <button
              className={`nav-item ${tab === 'models' ? 'active' : ''}`}
              onClick={() => setTab('models')}
            >
              <IconSettings width={17} height={17} />
              <span>Models</span>
            </button>
            <button
              className={`nav-item ${tab === 'browser' ? 'active' : ''}`}
              onClick={() => setTab('browser')}
            >
              <IconSearch width={17} height={17} />
              <span>Browser</span>
            </button>
            <button
              className={`nav-item ${tab === 'run' ? 'active' : ''}`}
              onClick={() => setTab('run')}
            >
              <IconTerminal width={17} height={17} />
              <span>Runtime</span>
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
                  <p>Plain conversation with your agent.</p>
                </div>
              </button>

              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'agent' ? 'active' : ''}`}
                onClick={() => handleModeSelect('agent')}
              >
                <div className="mode-card-icon purple"><IconAgent width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Agent</strong>
                  <p>Task-first workspace with tools.</p>
                </div>
              </button>

              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'coding' ? 'active' : ''}`}
                onClick={() => handleModeSelect('coding')}
              >
                <div className="mode-card-icon blue"><IconCoding width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Coding</strong>
                  <p>Coding-flavored starter prompts.</p>
                </div>
              </button>

              <button
                className={`mode-card ${tab === 'chat' && workspaceMode === 'research' ? 'active' : ''}`}
                onClick={() => handleModeSelect('research')}
              >
                <div className="mode-card-icon cyan"><IconResearch width={16} height={16} /></div>
                <div className="mode-card-info">
                  <strong>Research</strong>
                  <p>Research-flavored starter prompts.</p>
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
                {conn === 'open' ? 'Online' : conn === 'error' ? 'Offline' : 'Connecting…'}
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
              <p className="hint">The local runtime failed to start. Check <code>desktop/.hermes-serve.log</code> (fork mode; <code>MOCH_ATTACH=1</code> attaches an external serve on 9119).</p>
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
                  searchQuery={searchQuery}
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
              {tab === 'browser' && <BrowserTab />}
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
