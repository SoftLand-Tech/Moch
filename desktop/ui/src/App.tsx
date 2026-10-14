/**
 * Moch Desktop v0.3 — the full app surface, local-only.
 *
 * Tabs: Chat · Bots (fleet) · Crew (kanban) · Automations (cron) ·
 *       Skills · Models · Run — each wired to the fork's real RPCs,
 * same shapes as the RN app (app/(tabs)/* + src/lib/fleet.ts etc.):
 *   profiles.list / profiles.create / moch.profiles.delete /
 *   moch.fleet.status / moch.fleet.freeze / moch.skills.list /
 *   moch.kanban.tasks|create|complete / cron.manage / model.options /
 *   model.save_key / session.* / prompt.submit
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { JsonRpcGatewayClient } from '../../../app/src/protocol/json-rpc-gateway'
import Markdown from './Markdown'

type Cfg = { wsUrl: string; token: string; mode: string; home?: string; logTail?: string }
type Tab = 'chat' | 'bots' | 'crew' | 'automations' | 'skills' | 'models' | 'run'

type Block = { id: number; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'status'; text: string; live?: boolean; meta?: string }
type SessionRow = { session_id?: string; stored_session_id?: string; title?: string; updated_at?: number }
type FleetProfile = { name: string; description?: string; soul?: string; frozen?: boolean; gateHeld?: boolean; model?: { provider: string; default: string } }
type FleetStatus = { fleetEnabled: boolean; queue?: { slots: number; active: number }; profiles?: { name: string; frozen: boolean; gateHeld: boolean }[] }
type LaunchSkill = { name: string; description: string; path: string }
type Job = { job_id: string; name?: string; schedule?: string; prompt?: string; enabled?: boolean; next_run?: string }
type Task = { id?: string; title?: string; body?: string; assignee?: string; status?: string; state?: string }
type Provider = { slug?: string; name?: string; provider?: string; authenticated?: boolean; auth_type?: string; model?: string; default?: string }

function dbg(what: string, extra: Record<string, unknown> = {}) {
  fetch('/dbg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: Date.now(), what, ...extra }) }).catch(() => {})
}
const ev = (e: unknown): { type: string; session_id?: string; payload: any } => e as any

export default function App() {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [conn, setConn] = useState<'connecting' | 'open' | 'error'>('connecting')
  const [tab, setTab] = useState<Tab>('chat')
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
  const clientRef = useRef<JsonRpcGatewayClient | null>(null)
  const rpcRef = useRef<((m: string, p?: any) => Promise<any>) | null>(null)

  const [client, setClient] = useState<any>(null)

  useEffect(() => {
    ;(async () => {
      let cfg: Cfg
      try { cfg = await (await fetch('/moch-config.json')).json() } catch { setConn('error'); return }
      setCfg(cfg)
      dbg('cfg', { mode: cfg.mode })
      if (cfg.mode === 'error') { setConn('error'); return }
      const client = new JsonRpcGatewayClient({
        connectTimeoutMs: 15_000, requestTimeoutMs: 120_000,
        socketFactory: (url: string) => new WebSocket(url) as unknown as WebSocket,
      })
      clientRef.current = client
      rpcRef.current = (m: string, p: any = {}) => client.request(m, p)
      client.onAny((e) => { if (ev(e).type === 'gateway.ready') { setConn('open'); setClient(client); dbg('ws-open', {}) } })
      client.connect(`${cfg.wsUrl}?token=${encodeURIComponent(cfg.token)}`).catch((err) => { dbg('ws-error', { err: String(err) }); setConn('error') })
    })()
    return () => { clientRef.current?.close() }
  }, [])

  /** Selftest (?selftest=1): exercise EVERY tab's data path, report to /dbg. */
  useEffect(() => {
    if (conn !== 'open' || !location.search.includes('selftest=1')) return
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
    return <div className="wizard"><div className="mochi big">(●ᴗ●)</div><p className="dim">Moch</p></div>
  }
  if (!setupDone) {
    return <Wizard conn={conn} cfg={cfg} rpc={rpcRef} onDone={() => setSetupDone(true)} />
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="logo">◍</span> Moch
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
          <div className="fatal"><p>No local hermes found.</p><p className="hint">Check <code>desktop/.hermes-serve.log</code> — the shell tried the fork (9118) and attach (9119).</p></div>
        ) : conn !== 'open' ? (
          <div className="empty"><div className="mochi">(●ᴗ●)</div><p>connecting to your local agent…</p></div>
        ) : (
          <>
            {tab === 'chat' && <ChatTab rpc={rpcRef} client={client} />}
            {tab === 'bots' && <BotsTab rpc={rpcRef} />}
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

type RpcRef = { current: ((m: string, p?: any) => Promise<any>) | null }

/* ─────────────────── First-run setup (like the phone) ─────────────────── */
function Wizard({ conn, cfg, rpc, onDone }: { conn: string; cfg: Cfg | null; rpc: RpcRef; onDone: () => void }) {
  const [step, setStep] = useState<'welcome' | 'boot' | 'provider'>('welcome')
  const [providers, setProviders] = useState<Provider[]>([])
  const [slug, setSlug] = useState(''); const [key, setKey] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => { if (step === 'boot' && conn === 'open') setStep('provider') }, [step, conn])

  useEffect(() => {
    if (step !== 'provider' || conn !== 'open') return
    rpc.current!('model.options', { include_unconfigured: true })
      .then((r: any) => setProviders(r.providers ?? []))
      .catch((e: any) => setErr(String(e)))
  }, [step, conn])

  const saveKey = async () => {
    if (!slug.trim() || !key.trim()) return
    setErr('')
    try {
      await rpc.current!('model.save_key', { slug: slug.trim(), api_key: key.trim() })
      setKey(''); setSlug('')
      const r = await rpc.current!('model.options', { include_unconfigured: true })
      setProviders(r.providers ?? [])
      dbg('setup:key-saved', { slug })
    } catch (e) { setErr(String(e)) }
  }
  const finish = async () => {
    await fetch('/setup-done', { method: 'POST' }).catch(() => {})
    dbg('setup:done', {})
    onDone()
  }
  const connected = providers.some((p) => p.authenticated)

  if (cfg?.mode === 'error' || conn === 'error') {
    return (
      <div className="wizard">
        <div className="mochi big">(•́ ‸ •̀ )</div>
        <h1>Moch couldn't start its runtime</h1>
        <p className="dim">The fork (app/hermes-src) failed to serve on 127.0.0.1:9118.</p>
        <pre className="logtail">{cfg?.logTail || 'no log'}</pre>
        <button className="primary" onClick={() => location.reload()}>Retry</button>
      </div>
    )
  }

  return (
    <div className="wizard">
      {step === 'welcome' && (
        <>
          <div className="mochi big">(●ᴗ●)</div>
          <h1>Your own agent, on this PC.</h1>
          <p className="dim">
            Moch runs the agent <strong>locally inside this app</strong> — a private runtime with its own
            home, your keys, your sessions. No relay, no phone, nothing leaves this machine.
          </p>
          <button className="primary big-btn" onClick={() => setStep('boot')}>Set up Moch locally</button>
          <p className="dim small">This is the desktop twin of “Use this phone”.</p>
        </>
      )}
      {step === 'boot' && (
        <>
          <div className="mochi big spin-slow">(◐‿◑)</div>
          <h1>Starting your runtime…</h1>
          <p className="dim">Booting the agent from <code>app/hermes-src</code> in a Moch-owned home.</p>
          <p className="dim small">mode: {cfg?.mode ?? '…'} · gateway: {cfg?.wsUrl || '…'}</p>
        </>
      )}
      {step === 'provider' && (
        <>
          <div className="mochi big">(●ᴗ●)✦</div>
          <h1>Connect a model provider</h1>
          <p className="dim">The agent needs a provider key, stored locally in your Moch runtime.</p>
          {err && <div className="err">{err}</div>}
          <div className="providerlist">
            {providers.map((p, i) => (
              <div key={p.slug ?? p.name ?? i} className={`provider ${p.authenticated ? 'ok' : ''}`}>
                <span>{p.name ?? p.slug}</span>
                <span className={`pill ${p.authenticated ? 'ok' : 'warn'}`}>{p.authenticated ? 'connected' : p.auth_type === 'api_key' ? 'api key' : '—'}</span>
              </div>
            ))}
          </div>
          <div className="card form">
            <div className="row">
              <input list="slugs" placeholder="provider (e.g. openai)" value={slug} onChange={(e) => setSlug(e.target.value)} />
              <datalist id="slugs">{providers.filter((p) => !p.authenticated && p.auth_type === 'api_key').map((p, i) => <option key={i} value={p.slug ?? p.name ?? ''} />)}</datalist>
              <input type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="row">
              <button className="primary" onClick={saveKey}>Save key</button>
              <button className="ghost" onClick={finish}>{connected ? 'Finish ✓' : 'Skip for now'}</button>
            </div>
          </div>
          {connected && <p className="dim small">Provider connected — you're set. Finish to start chatting.</p>}
        </>
      )}
    </div>
  )
}

/* ───────────────────────── Chat ───────────────────────── */
function ChatTab({ rpc, client }: { rpc: RpcRef; client: any }) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [activeSid, setActiveSid] = useState('')
  const [blocks, setBlocks] = useState<Record<string, Block[]>>({})
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState(true)
  const blockId = useRef(1)
  const blocksRef = useRef(blocks); blocksRef.current = blocks
  const activeRef = useRef(activeSid); activeRef.current = activeSid

  const pushBlock = (sid: string, b: Omit<Block, 'id'>) =>
    setBlocks((p) => ({ ...p, [sid]: [...(p[sid] ?? []), { ...b, id: blockId.current++ }] }))
  const patchBlock = (sid: string, pred: (b: Block) => boolean, patch: any) =>
    setBlocks((p) => {
      const list = p[sid] ?? []; const i = list.findIndex(pred); if (i < 0) return p
      const next = list.slice(); next[i] = { ...next[i], ...(typeof patch === 'function' ? patch(next[i]) : patch) }
      return { ...p, [sid]: next }
    })

  const applyEvent = useCallback((e: unknown) => {
    const { type, session_id: sid, payload: p } = ev(e)
    if (!sid) return
    const last = (pred: (b: Block) => boolean) => (blocksRef.current[sid] ?? []).findLast(pred)
    switch (type) {
      case 'message.start': pushBlock(sid, { kind: 'assistant', text: '', live: true }); break
      case 'message.delta': case 'message.interim': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'assistant' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: type === 'message.interim' ? text : b.text + text }))
        else pushBlock(sid, { kind: 'assistant', text, live: true })
        break
      }
      case 'message.complete':
        patchBlock(sid, (b) => b.kind === 'assistant' && b.live, (b: Block) => ({ live: false, text: p?.text != null ? String(p.text) : b.text }))
        setBusy(false); break
      case 'thinking.delta': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'thinking' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: b.text + text }))
        else pushBlock(sid, { kind: 'thinking', text, live: true })
        break
      }
      case 'tool.start': pushBlock(sid, { kind: 'tool', text: String(p?.name ?? p?.tool ?? 'tool'), live: true }); break
      case 'tool.complete': patchBlock(sid, (b) => b.kind === 'tool' && b.live, { live: false, meta: [p?.name, p?.ms != null ? `${p.ms}ms` : null].filter(Boolean).join(' · ') }); break
      case 'status.update': if (p?.status) pushBlock(sid, { kind: 'status', text: String(p.status) }); break
    }
  }, [])

  useEffect(() => {
    if (!client) return
    const un = client.onAny((e: unknown) => {
      const { type } = ev(e)
      if (type === 'gateway.ready') {
        rpc.current!('session.list', { limit: 200 })
          .then((r: any) => setSessions((r.sessions ?? []).slice().sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))))
          .catch(() => {})
      }
      applyEvent(e)
    })
    return un
  }, [client, applyEvent])

  const send = async () => {
    const text = draft.trim(); if (!text || busy) return
    const r = rpc.current!; setDraft(''); setBusy(true)
    try {
      let sid = activeRef.current
      if (!sid) {
        const cr = await r('session.create', { title: 'Desktop chat', cols: 120, source: 'mobile' })
        sid = cr.session_id; setBlocks((p) => ({ ...p, [sid]: [] })); setActiveSid(sid)
        setSessions((p) => [{ session_id: sid, title: 'Desktop chat' }, ...p])
      }
      pushBlock(sid, { kind: 'user', text })
      await r('prompt.submit', { session_id: sid, text })
    } catch { setBusy(false) }
  }

  const list = blocks[activeSid] ?? []
  return (
    <div className="chatwrap">
      {panel && (
        <div className="sessions-panel">
          <button className="new-chat" onClick={() => { setActiveSid(''); setDraft('') }}>+ New chat</button>
          <div className="sessions">
            {sessions.map((s) => {
              const key = s.stored_session_id ?? s.session_id ?? ''
              return (
                <button key={key} className={`session ${activeSid === s.session_id ? 'active' : ''}`}
                  onClick={async () => {
                    const r = rpc.current!
                    try {
                      const rr = await r('session.resume', { session_id: key, cols: 120 })
                      const live = rr.session_id
                      const rep = await r('session.events.since', { session_id: live, last_seen: 0 })
                      setBlocks((p) => ({ ...p, [live]: [] })); setActiveSid(live)
                      for (const e of rep.events ?? []) applyEvent(e)
                    } catch { }
                  }}>
                  {s.title || key.slice(0, 18)}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div className="chat">
        <div className="messages">
          {list.length === 0 && <div className="empty"><div className="mochi">(●ᴗ●)</div><p>Your agent, on this machine.</p></div>}
          {list.map((b) =>
            b.kind === 'user' ? <div key={b.id} className="msg user">{b.text}</div>
            : b.kind === 'assistant' ? (
              <div key={b.id} className={`msg assistant${b.live ? ' live' : ''}`}>
                {b.live ? (b.text || '▍') : (b.text ? <Markdown text={b.text} /> : null)}
              </div>
            )
            : b.kind === 'thinking' ? (
              <details key={b.id} className="thinking"><summary>Thinking{b.live ? '…' : ''}</summary><pre>{b.text}</pre></details>
            ) : b.kind === 'tool' ? (
              <div key={b.id} className="tool"><span className={`dot${b.live ? '' : ' done'}`}>{b.live ? '◌' : '●'}</span> {b.text}{b.meta ? <span className="meta"> {b.meta}</span> : null}</div>
            ) : <div key={b.id} className="statusline">{b.text}</div>,
          )}
        </div>
        <div className="composer">
          <textarea value={draft} placeholder="Message your agent…" onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="send" onClick={send} disabled={!draft.trim() || busy}>{busy ? '…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── Bots (fleet) ───────────────────────── */
function BotsTab({ rpc }: { rpc: RpcRef }) {
  const [profiles, setProfiles] = useState<FleetProfile[]>([])
  const [status, setStatus] = useState<FleetStatus | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [soul, setSoul] = useState('')
  const load = async () => {
    const r = rpc.current!; setErr('')
    try {
      const lst = await r('profiles.list', {})
      const rows = lst.profiles ?? lst.items ?? (Array.isArray(lst) ? lst : [])
      setProfiles(rows)
      setStatus(await r('moch.fleet.status', {}).catch(() => null))
    } catch (e) { setErr(String(e)) }
  }
  useEffect(() => { if (rpc.current) load() }, [])
  const create = async () => {
    if (!name.trim()) return
    const r = rpc.current!
    try {
      await r('profiles.create', { name: name.trim(), description: desc, soul, no_alias: true, mirror_credentials: true })
      setName(''); setDesc(''); setSoul(''); setCreating(false); load()
    } catch (e) { setErr(String(e)) }
  }
  return (
    <div className="page">
      <div className="pagehead">
        <h2>Bots</h2>
        {status && <span className={`pill ${status.fleetEnabled ? 'ok' : ''}`}>fleet {status.fleetEnabled ? 'armed' : 'off'}</span>}
        {status?.queue && <span className="pill">queue {status.queue.active}/{status.queue.slots}</span>}
        <button className="ghost" onClick={load}>refresh</button>
        <button className="primary" onClick={() => setCreating(!creating)}>+ New bot</button>
      </div>
      {err && <div className="err">{err}</div>}
      {creating && (
        <div className="card form">
          <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="description (what is this bot for?)" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <textarea placeholder="soul (personality / instructions)" value={soul} onChange={(e) => setSoul(e.target.value)} />
          <div className="row"><button className="primary" onClick={create}>Create bot</button><button className="ghost" onClick={() => setCreating(false)}>cancel</button></div>
        </div>
      )}
      {profiles.length === 0 && <div className="empty"><p>No profiles yet — create your first bot.</p></div>}
      {profiles.map((p) => {
        const st = status?.profiles?.find((s) => s.name === p.name)
        return (
          <div key={p.name} className="card bot">
            <div className="row">
              <strong>{p.name}</strong>
              {st?.frozen && <span className="pill">frozen</span>}
              {st?.gateHeld && <span className="pill">gate held</span>}
              {p.model?.default && <span className="pill dim">{p.model.default}</span>}
              <span className="spacer" />
              <button className="ghost" onClick={async () => { await rpc.current!('moch.fleet.freeze', { profile: p.name, frozen: !st?.frozen }).catch(() => {}); load() }}>
                {st?.frozen ? 'unfreeze' : 'freeze'}
              </button>
              <button className="ghost danger" onClick={async () => { await rpc.current!('moch.profiles.delete', { profile: p.name }).catch((e) => setErr(String(e))); load() }}>delete</button>
            </div>
            {p.description && <p className="dim">{p.description}</p>}
          </div>
        )
      })}
    </div>
  )
}

/* ───────────────────────── Crew (kanban) ───────────────────────── */
function CrewTab({ rpc }: { rpc: RpcRef }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [err, setErr] = useState('')
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [assignee, setAssignee] = useState('')
  const load = async () => { try { setTasks((await rpc.current!('moch.kanban.tasks', { limit: 120 })).tasks ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])
  const create = async () => {
    if (!title.trim()) return
    try {
      await rpc.current!('moch.kanban.create', { title: title.trim(), body: body.trim(), assignee: assignee.trim() || undefined, idempotency_key: `desk-${Date.now()}` })
      setTitle(''); setBody(''); setAssignee(''); load()
    } catch (e) { setErr(String(e)) }
  }
  return (
    <div className="page">
      <div className="pagehead"><h2>Crew</h2><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <input placeholder="task title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="assignee (bot name, optional)" value={assignee} onChange={(e) => setAssignee(e.target.value)} />
        <textarea placeholder="body — what should be done" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row"><button className="primary" onClick={create}>Create task</button></div>
      </div>
      {tasks.map((t, i) => (
        <div key={t.id ?? i} className="card">
          <div className="row">
            <strong>{t.title ?? t.id}</strong>
            {t.assignee && <span className="pill">→ {t.assignee}</span>}
            {t.status && <span className="pill dim">{t.status}</span>}
            <span className="spacer" />
            <button className="ghost" onClick={async () => { await rpc.current!('moch.kanban.complete', { task: t.id ?? t.title }).catch((e) => setErr(String(e))); load() }}>complete</button>
          </div>
          {t.body && <p className="dim">{t.body}</p>}
        </div>
      ))}
    </div>
  )
}

/* ───────────────────────── Automations (cron) ───────────────────────── */
function AutomationsTab({ rpc }: { rpc: RpcRef }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [err, setErr] = useState('')
  const [name, setName] = useState(''); const [schedule, setSchedule] = useState('every 30m'); const [prompt, setPrompt] = useState('')
  const load = async () => { try { setJobs((await rpc.current!('cron.manage', { action: 'list', include_disabled: true })).jobs ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])
  const add = async () => {
    if (!name.trim() || !prompt.trim()) return
    try { await rpc.current!('cron.manage', { action: 'add', name: name.trim(), schedule, prompt }); setName(''); setPrompt(''); load() } catch (e) { setErr(String(e)) }
  }
  return (
    <div className="page">
      <div className="pagehead"><h2>Automations</h2><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <div className="row"><input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} /><input placeholder="schedule (every 30m, every monday 9:00…)" value={schedule} onChange={(e) => setSchedule(e.target.value)} /></div>
        <textarea placeholder="prompt — what should run" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="row"><button className="primary" onClick={add}>Create automation</button></div>
      </div>
      {jobs.map((j) => (
        <div key={j.job_id} className="card">
          <div className="row">
            <strong>{j.name ?? j.job_id}</strong>
            {j.enabled === false && <span className="pill">paused</span>}
            {j.schedule && <span className="pill dim">{j.schedule}</span>}
            <span className="spacer" />
            <button className="ghost" onClick={async () => { await rpc.current!('cron.manage', { action: j.enabled === false ? 'resume' : 'pause', name: j.job_id }); load() }}>
              {j.enabled === false ? 'resume' : 'pause'}
            </button>
            <button className="ghost danger" onClick={async () => { await rpc.current!('cron.manage', { action: 'remove', name: j.job_id }); load() }}>remove</button>
          </div>
          {j.prompt && <p className="dim">{j.prompt}</p>}
        </div>
      ))}
    </div>
  )
}

/* ───────────────────────── Skills ───────────────────────── */
function SkillsTab({ rpc }: { rpc: RpcRef }) {
  const [skills, setSkills] = useState<LaunchSkill[]>([])
  const [commands, setCommands] = useState(0)
  const [err, setErr] = useState('')
  useEffect(() => {
    ;(async () => {
      try { setSkills((await rpc.current!('moch.skills.list', {})).skills ?? []) } catch (e) { setErr(String(e)) }
      try { setCommands(Object.keys((await rpc.current!('commands.catalog', {})).commands ?? {}).length) } catch { }
    })()
  }, [])
  return (
    <div className="page">
      <div className="pagehead"><h2>Skills</h2><span className="pill dim">{commands} slash commands</span></div>
      {err && <div className="err">{err}</div>}
      {skills.map((s) => (
        <div key={s.path ?? s.name} className="card"><strong>{s.name}</strong>{s.description && <p className="dim">{s.description}</p>}</div>
      ))}
      {skills.length === 0 && <div className="empty"><p>No launch skills found.</p></div>}
    </div>
  )
}

/* ───────────────────────── Models ───────────────────────── */
function ModelsTab({ rpc }: { rpc: RpcRef }) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [err, setErr] = useState('')
  const [slug, setSlug] = useState(''); const [key, setKey] = useState('')
  const load = async () => { try { setProviders((await rpc.current!('model.options', { include_unconfigured: true })).providers ?? []) } catch (e) { setErr(String(e)) } }
  useEffect(() => { if (rpc.current) load() }, [])
  return (
    <div className="page">
      <div className="pagehead"><h2>Models</h2><button className="ghost" onClick={load}>refresh</button></div>
      {err && <div className="err">{err}</div>}
      <div className="card form">
        <div className="row"><input placeholder="provider slug" value={slug} onChange={(e) => setSlug(e.target.value)} /><input type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} /></div>
        <div className="row"><button className="primary" onClick={async () => { try { await rpc.current!('model.save_key', { slug: slug.trim(), api_key: key }); setSlug(''); setKey(''); load() } catch (e) { setErr(String(e)) } }}>Save key</button></div>
      </div>
      {providers.map((p, i) => (
        <div key={p.slug ?? p.name ?? i} className="card">
          <div className="row">
            <strong>{p.name ?? p.slug}</strong>
            <span className={`pill ${p.authenticated ? 'ok' : 'warn'}`}>{p.authenticated ? 'connected' : 'not connected'}</span>
            {p.auth_type === 'api_key' && !p.authenticated && <span className="pill dim">api key</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ───────────────────────── Run (local status) ───────────────────────── */
function RunTab({ cfg, rpc }: { cfg: Cfg | null; rpc: RpcRef }) {
  const [ping, setPing] = useState<string>('')
  return (
    <div className="page">
      <div className="pagehead"><h2>Run locally</h2></div>
      <div className="card">
        <div className="row"><span className="dim">mode</span><strong>{cfg?.mode}</strong></div>
        <div className="row"><span className="dim">gateway</span><code>{cfg?.wsUrl || '—'}</code></div>
        <div className="row"><span className="dim">token</span><code>{cfg?.token ? '•••• held by this app' : '—'}</code></div>
        <p className="dim" style={{ marginTop: 8 }}>
          The shell spawns the hermes fork (<code>app/hermes-src</code>) on 127.0.0.1:9118 and falls back to
          the machine serve on 9119. Sessions and providers live in the same <code>~/.hermes</code> as the CLI.
        </p>
        <div className="row"><button className="primary" onClick={async () => { try { const r = await rpc.current!('gateway.ping', {}); setPing(r?.ok === true ? 'gateway ok' : JSON.stringify(r)) } catch (e) { setPing(String(e)) } }}>ping gateway</button>{ping && <span className="pill ok">{ping}</span>}</div>
      </div>
    </div>
  )
}
