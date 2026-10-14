/**
 * Moch Desktop v0.4 — the app shell, local-only.
 *
 * Tabs live in src/tabs/* (round 4 refactor): Chat · Bots (fleet) · Crew
 * (kanban) · Automations (cron) · Skills · Models · Run — each wired to the
 * fork's real RPCs, same shapes as the RN app (app/(tabs)/* + src/lib/fleet.ts
 * etc.): profiles.list / profiles.create / moch.profiles.seed|delete /
 * moch.fleet.status / moch.fleet.freeze / moch.skills.list /
 * moch.kanban.tasks|create|complete / cron.manage / model.options /
 * model.save_key / session.* / prompt.submit
 */
import { useEffect, useRef, useState } from 'react'
import { JsonRpcGatewayClient } from '../../../app/src/protocol/json-rpc-gateway'
import { dbg, ev, type Cfg, type Tab } from './types'
import Wizard from './tabs/Wizard'
import ChatTab from './tabs/Chat'
import BotsTab from './tabs/Bots'
import CrewTab from './tabs/Crew'
import AutomationsTab from './tabs/Automations'
import SkillsTab from './tabs/Skills'
import ModelsTab from './tabs/Models'
import RunTab from './tabs/Run'

export default function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting')
  const [tab, setTab] = useState<Tab>('chat')
  const [chatProfile, setChatProfile] = useState('')
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
  const clientRef = useRef<JsonRpcGatewayClient | null>(null)
  const rpcRef = useRef<((m: string, p?: any) => Promise<any>) | null>(null)
  const urlRef = useRef('')

  const [client, setClient] = useState<any>(null)
  const selftestRan = useRef(false)

  // Boot + reconnect supervisor: initial connect, then backoff retries and
  // silent-drop detection (the gateway restarting under us) — the conn
  // badge must tell the truth (both round-5 builders flagged this gap).
  useEffect(() => {
    let closed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let watchdog: ReturnType<typeof setTimeout> | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let attempt = 0
    let everOpened = false

    const dial = () => {
      if (closed) return
      const url = urlRef.current
      if (!url) return
      setConn('connecting')
      const c = new JsonRpcGatewayClient({
        connectTimeoutMs: 15_000, requestTimeoutMs: 120_000,
        socketFactory: (u: string) => new WebSocket(u) as unknown as WebSocket,
      })
      clientRef.current = c
      rpcRef.current = (m: string, p: any = {}) => c.request(m, p)
      c.onAny((e) => {
        if (ev(e).type === 'gateway.ready') {
          attempt = 0
          setConn('open')
          setClient(c)
          dbg(everOpened ? 'ws-reconnected' : 'ws-open', {})
          everOpened = true
        }
      })
      c.connect(url).catch(() => { /* watchdog reschedules */ })
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (!closed && c.connectionState !== 'open') {
          try { c.close() } catch { }
          schedule()
        }
      }, 20_000)
    }
    const schedule = () => {
      if (closed) return
      const delay = everOpened ? Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4)) : Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 3))
      attempt++
      timer = setTimeout(dial, delay)
    }

    ;(async () => {
      let cfg: Cfg
      try { cfg = await (await fetch('/moch-config.json')).json() } catch { setConn('error'); return }
      setCfg(cfg)
      dbg('cfg', { mode: cfg.mode })
      if (cfg.mode === 'error') { setConn('error'); return }
      urlRef.current = `${cfg.wsUrl}?token=${encodeURIComponent(cfg.token)}`
      dial()
      poll = setInterval(() => {
        const c = clientRef.current
        if (c && everOpened && c.connectionState === 'closed') {
          dbg('ws-drop', {})
          schedule()
        }
      }, 3_000)
    })()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      if (watchdog) clearTimeout(watchdog)
      if (poll) clearInterval(poll)
      clientRef.current?.close()
    }
  }, [])

  /** Selftest (?selftest=1): exercise EVERY tab's data path, report to /dbg. */
  useEffect(() => {
    if (conn !== 'open' || !location.search.includes('selftest=1')) return
    if (selftestRan.current) return
    selftestRan.current = true
    ;(async () => {
      const r = rpcRef.current!
      const try_ = async (what: string, m: string, p: any) => {
        try { const res = await r(m, p); dbg(`selftest:${what}`, { ok: true, n: Array.isArray(res) ? res.length : Object.keys(res ?? {}).length }) }
        catch (e) { dbg(`selftest:${what}`, { ok: false, err: String(e).slice(0, 140) }) }
      }
      await try_('sessions', 'session.list', { limit: 200 })
      await try_('profiles', 'profiles.list', {})
      await try_('fleet', 'moch.fleet.status', {})
      await try_('skills', 'moch.skills.list', {})
      await try_('cron', 'cron.manage', { action: 'list', include_disabled: true })
      await try_('kanban', 'moch.kanban.tasks', { limit: 120 })
      await try_('models', 'model.options', { include_unconfigured: true })
      // chat round trip
      try {
        const c = await r('session.create', { title: 'selftest', cols: 120, source: 'mobile' })
        await r('prompt.submit', { session_id: c.session_id, text: 'Reply with the single word READY and nothing else.' })
        dbg('selftest:submitted', {})
      } catch (e) { dbg('selftest:chat-error', { err: String(e).slice(0, 140) }) }
    })()
  }, [conn])

  // First-run gate: /setup.json (written by the shell on POST /setup-done).
  useEffect(() => {
    fetch('/setup.json').then((r) => r.json()).then((s) => setSetupDone(!!s.done)).catch(() => setSetupDone(false))
  }, [])

  if (setupDone === null) {
    return <div className="wizard"><img className="mochi-img" src="/brand/mochi-connecting.svg" alt="Mochi" /><p className="dim">Moch</p></div>
  }
  if (!setupDone) {
    return <Wizard conn={conn} cfg={cfg} rpc={rpcRef} onDone={() => setSetupDone(true)} />
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><img className="logo-img" src="/brand/logo.png" alt="Moch" /> Moch
          <span className={`badge ${cfg?.mode ?? ''}`}>{cfg?.mode === 'fork' ? 'fork' : cfg?.mode ?? '…'}</span>
        </div>
        <nav className="tabs">
          {(['chat', 'bots', 'crew', 'automations', 'skills', 'models', 'run'] as Tab[]).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
        <div className={`conn ${conn}`}>{conn === 'open' ? '● local hermes' : conn === 'connecting' ? '◌ connecting…' : '✕ no local hermes'}</div>
      </aside>
      <main className="main">
        {conn === 'error' ? (
          <div className="fatal"><img className="mochi-img" src="/brand/mochi-offline.svg" alt="Mochi" /><p>No local runtime found.</p><p className="hint">Check <code>desktop/.hermes-serve.log</code> — the shell tried the fork (9118) and attach (9119).</p></div>
        ) : conn !== 'open' ? (
          <div className="empty"><img className="mochi-img" src="/brand/mochi-connecting.svg" alt="Mochi" /><p>connecting to your local agent…</p></div>
        ) : (
          <>
            {tab === 'chat' && <ChatTab rpc={rpcRef} client={client} profile={chatProfile} onProfile={setChatProfile} />}
            {tab === 'bots' && <BotsTab rpc={rpcRef} onChat={(name) => { setChatProfile(name); setTab('chat') }} />}
            {tab === 'crew' && <CrewTab rpc={rpcRef} />}
            {tab === 'automations' && <AutomationsTab rpc={rpcRef} />}
            {tab === 'skills' && <SkillsTab rpc={rpcRef} />}
            {tab === 'models' && <ModelsTab rpc={rpcRef} />}
            {tab === 'run' && <RunTab cfg={cfg} rpc={rpcRef} />}
          </>
        )}
      </main>
    </div>
  )
}
