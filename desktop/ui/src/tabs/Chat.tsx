/**
 * Chat / Agent Workspace — layout and components matching the dashboard mockup:
 * - Header: Mode title + subtitle
 * - Top Quick Task Box ("What should Moch work on?" + Attach/Tools/Project + Send)
 * - Hero Empty State (Center Mochi mascot + "Ready when you are" + 6 Example Tasks)
 * - Message Stream (cream user bubble, assistant markdown, thinking, tools)
 * - Floating Bottom Composer ("Ask Moch anything..." + Hermes model badge + Send)
 * - Clean session switcher pills bar
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Markdown from '../Markdown'
import {
  IconAgent,
  IconAttach,
  IconBug,
  IconCalendar,
  IconChart,
  IconCoding,
  IconFolder,
  IconLock,
  IconPlus,
  IconResearch,
  IconSend,
  IconSparkles,
  IconTools,
} from '../Icons'
import { ev, relTime, type Block, type RpcRef, type SessionRow } from '../types'
import type { ActiveTaskState, ActivityItem } from '../RightPanel'
import MochiInteractive from '../MochiInteractive'

const EXAMPLE_TASKS = [
  {
    icon: 'code',
    title: 'Build a Laravel feature',
    desc: 'Create a new feature, run tests, and push to GitHub',
    prompt: 'Build a Laravel feature: create a new feature, run tests, and push to GitHub.',
  },
  {
    icon: 'bug',
    title: 'Fix a bug',
    desc: 'Find the issue, fix it, and explain the changes',
    prompt: 'Find the bug, fix it, and explain what caused it and the changes made.',
  },
  {
    icon: 'research',
    title: 'Research a topic',
    desc: 'Find, read, and summarize the latest information',
    prompt: 'Research this topic: find, read, and summarize the latest findings and insights.',
  },
  {
    icon: 'chart',
    title: 'Analyze data',
    desc: 'Process data and generate insights',
    prompt: 'Analyze data: process the inputs and generate actionable insights and charts.',
  },
  {
    icon: 'folder',
    title: 'Organize my files',
    desc: 'Sort and clean up my project directory',
    prompt: 'Organize my files: sort and clean up the current project directory with best practices.',
  },
  {
    icon: 'calendar',
    title: 'Plan a project',
    desc: 'Create a step-by-step plan with milestones',
    prompt: 'Plan a project: create a step-by-step implementation plan with concrete milestones.',
  },
]

export default function ChatTab({
  rpc,
  client,
  profile,
  onProfile,
  mode = 'agent',
  onActivity,
  onTaskUpdate,
  onWorkingChange,
}: {
  rpc: RpcRef
  client: { onAny: (cb: (e: unknown) => void) => () => void } | null
  profile: string
  onProfile: (p: string) => void
  mode?: 'agent' | 'chat' | 'coding' | 'research'
  onActivity?: (item: ActivityItem) => void
  onTaskUpdate?: (task: ActiveTaskState | null) => void
  onWorkingChange?: (working: boolean) => void
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [activeSid, setActiveSid] = useState('')
  const [blocks, setBlocks] = useState<Record<string, Block[]>>({})
  const [draft, setDraft] = useState('')
  const [quickDraft, setQuickDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [turnMochi, setTurnMochi] = useState<'' | 'listening' | 'celebration'>('')
  const [roster, setRoster] = useState<string[]>([])
  const [modelName, setModelName] = useState('Hermes')
  const [showSessionsDrawer, setShowSessionsDrawer] = useState(false)

  const blockId = useRef(1)
  const blocksRef = useRef(blocks); blocksRef.current = blocks
  const activeRef = useRef(activeSid); activeRef.current = activeSid
  const onActivityRef = useRef(onActivity); onActivityRef.current = onActivity
  const onWorkingChangeRef = useRef(onWorkingChange); onWorkingChangeRef.current = onWorkingChange

  const pushBlock = (sid: string, b: Omit<Block, 'id'>) =>
    setBlocks((p) => ({ ...p, [sid]: [...(p[sid] ?? []), { ...b, id: blockId.current++ }] }))

  const patchBlock = (sid: string, pred: (b: Block) => boolean, patch: Partial<Block> | ((b: Block) => Partial<Block>)) =>
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
      case 'message.start':
        pushBlock(sid, { kind: 'assistant', text: '', live: true })
        setTurnMochi('listening')
        setBusy(true)
        onWorkingChangeRef.current?.(true)
        break
      case 'message.delta':
      case 'message.interim': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'assistant' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: type === 'message.interim' ? text : b.text + text }))
        else pushBlock(sid, { kind: 'assistant', text, live: true })
        break
      }
      case 'message.complete':
        patchBlock(sid, (b) => b.kind === 'assistant' && b.live, (b: Block) => ({ live: false, text: p?.text != null ? String(p.text) : b.text }))
        setBusy(false)
        onWorkingChangeRef.current?.(false)
        setTurnMochi('celebration')
        setTimeout(() => setTurnMochi(''), 2600)
        break
      case 'thinking.delta': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'thinking' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: b.text + text }))
        else pushBlock(sid, { kind: 'thinking', text, live: true })
        break
      }
      case 'tool.start': {
        const toolName = String(p?.name ?? p?.tool ?? 'tool')
        pushBlock(sid, { kind: 'tool', text: toolName, live: true })
        onActivityRef.current?.({
          id: Date.now() + Math.random(),
          kind: toolName.includes('file') || toolName.includes('read') ? 'file' : toolName.includes('bash') || toolName.includes('terminal') ? 'command' : toolName.includes('search') ? 'search' : 'tool',
          title: toolName.includes('read') ? 'Read file' : toolName.includes('write') ? 'Write file' : toolName.includes('bash') ? 'Run command' : toolName.includes('search') ? 'Search' : `Execute ${toolName}`,
          subtitle: String(p?.input?.path ?? p?.input?.query ?? p?.input?.command ?? toolName).slice(0, 48),
          time: 'just now',
        })
        break
      }
      case 'tool.complete':
        patchBlock(sid, (b) => b.kind === 'tool' && b.live, { live: false, meta: [p?.name, p?.ms != null ? `${p.ms}ms` : null].filter(Boolean).join(' · ') })
        break
      case 'status.update':
        if (p?.status) pushBlock(sid, { kind: 'status', text: String(p.status) })
        break
    }
  }, [])

  const loadSessions = useCallback(async (prof: string) => {
    const r = rpc.current; if (!r) return
    try {
      const res = await r('session.list', prof && prof !== 'default' ? { limit: 200, profile: prof } : { limit: 200 })
      const rows: SessionRow[] = Array.isArray(res) ? res : res.sessions ?? res.items ?? []
      setSessions(rows.filter((s) => s.id ?? s.stored_session_id ?? s.session_id))
    } catch { }
  }, [rpc])

  const loadRoster = useCallback(async () => {
    const r = rpc.current; if (!r) return
    try {
      const res = await r('profiles.list', {})
      const rows = res.profiles ?? res.items ?? []
      setRoster(rows.map((p: { name: string }) => p.name).filter((n: string) => n && n !== 'default'))
    } catch { }
  }, [rpc])

  // Load configured model name
  useEffect(() => {
    if (!rpc.current) return
    rpc.current('config.get', { key: 'provider' })
      .then((r: unknown) => {
        if (r && typeof r === 'object' && 'model' in r && typeof r.model === 'string') {
          setModelName(r.model.split('/').pop() || 'Hermes')
        }
      })
      .catch(() => {})
  }, [rpc])

  const profRef = useRef(profile); profRef.current = profile
  useEffect(() => {
    if (!client) return
    void loadSessions(profRef.current)
    void loadRoster()
    const un = client.onAny((e: unknown) => {
      const { type } = ev(e)
      if (type === 'gateway.ready') { void loadSessions(profRef.current); void loadRoster() }
      applyEvent(e)
    })
    return un
  }, [client, applyEvent, loadSessions, loadRoster])

  useEffect(() => { setActiveSid(''); void loadSessions(profile) }, [profile, loadSessions])

  const handleSend = async (customText?: string) => {
    const text = (customText ?? draft ?? quickDraft).trim()
    if (!text || busy) return
    const r = rpc.current!; setDraft(''); setQuickDraft(''); setBusy(true)
    onWorkingChangeRef.current?.(true)

    // Notify task update
    onTaskUpdate?.({
      title: text.slice(0, 50),
      subtitle: 'Executing autonomous turn...',
      step: 1,
      total: 5,
      steps: [
        { label: 'Parse user prompt', time: 'just now', done: true },
        { label: 'Search relevant tools & context', active: true },
        { label: 'Execute plan and subtasks' },
        { label: 'Verify result' },
        { label: 'Deliver response' },
      ],
    })

    const prof = profile && profile !== 'default' ? profile : undefined

    try {
      let sid = activeRef.current
      if (!sid) {
        const cr = await r<{ session_id: string }>('session.create', {
          title: prof ? `${prof} · chat` : text.slice(0, 32),
          cols: 120,
          source: 'mobile',
          ...(prof ? { profile: prof, follow_profile_config: true } : {}),
        })
        sid = cr.session_id
        activeRef.current = sid
        setBlocks((p) => ({ ...p, [sid]: [{ id: blockId.current++, kind: 'user', text }] }))
        setActiveSid(sid)
        setSessions((p) => [
          {
            session_id: sid,
            title: prof ? `${prof} · chat` : text.slice(0, 32),
            started_at: Date.now() / 1000,
            profile: prof,
          },
          ...p,
        ])
      } else {
        pushBlock(sid, { kind: 'user', text })
      }

      await r('prompt.submit', { session_id: sid, text })
    } catch (err) {
      console.error('submit error:', err)
      setBusy(false)
      onWorkingChangeRef.current?.(false)
    }
  }

  const list = blocks[activeSid] ?? []
  const hasMessages = list.length > 0

  const modeHeaders = {
    agent: {
      title: 'Agent',
      subtitle: 'Give Moch a task and watch it work. It can use tools, read files, run commands, and keep you updated.',
    },
    chat: {
      title: 'Chat',
      subtitle: 'Direct conversation with your Hermes agent. Ask questions, explore ideas, and get instant answers.',
    },
    coding: {
      title: 'Coding',
      subtitle: 'Dev-first workspace with repo tools, terminal execution, and automated testing.',
    },
    research: {
      title: 'Research',
      subtitle: 'Deep web search, document analysis, and comprehensive briefings.',
    },
  }

  const currentMode = modeHeaders[mode] || modeHeaders.agent

  return (
    <div className="agent-workspace">
      {/* ── Top Canvas Header ── */}
      <div className="canvas-header">
        <div className="header-title-row">
          <div className="mode-badge-icon">
            {mode === 'coding' ? <IconCoding width={20} height={20} />
              : mode === 'research' ? <IconResearch width={20} height={20} />
              : mode === 'chat' ? <IconSparkles width={20} height={20} />
              : <IconAgent width={20} height={20} />}
          </div>
          <div className="header-text">
            <h2>{profile && profile !== 'default' ? profile : currentMode.title}</h2>
            <p>{profile && profile !== 'default' ? `${profile} is active and ready.` : currentMode.subtitle}</p>
          </div>
        </div>

        {/* Sessions toggle / quick switcher */}
        <div className="session-switcher-bar">
          <button
            className="session-pill-btn new"
            onClick={() => { setActiveSid(''); setDraft(''); setQuickDraft('') }}
          >
            <IconPlus width={13} height={13} />
            <span>New chat</span>
          </button>

          <button
            className={`session-pill-btn ${!profile || profile === 'default' ? 'active' : ''}`}
            onClick={() => onProfile('')}
          >
            Moch
          </button>
          {roster.map((n) => (
            <button
              key={n}
              className={`session-pill-btn ${profile === n ? 'active' : ''}`}
              onClick={() => onProfile(n)}
            >
              {n}
            </button>
          ))}

          {sessions.length > 0 && (
            <button
              className={`session-pill-btn drawer-toggle ${showSessionsDrawer ? 'active' : ''}`}
              onClick={() => setShowSessionsDrawer((v) => !v)}
            >
              {sessions.length} chats ▾
            </button>
          )}
        </div>

        {/* Top-Right Corner Mochi Mascot (76px, active chat) */}
        {hasMessages && (
          <div className="corner-mascot-wrapper">
            <div className="radial-glow-aura corner" />
            <MochiInteractive
              state={
                turnMochi === 'celebration'
                  ? 'mochi-celebration'
                  : busy
                  ? 'mochi-listening'
                  : 'mochi'
              }
              size={76}
            />
          </div>
        )}

        {/* Expandable Sessions Drawer */}
        {showSessionsDrawer && (
          <div className="sessions-drawer-popover">
            <div className="drawer-head">
              <span>Recent sessions</span>
              <button className="close-btn" onClick={() => setShowSessionsDrawer(false)}>✕</button>
            </div>
            <div className="drawer-list">
              {sessions.map((s) => {
                const key = s.id ?? s.stored_session_id ?? s.session_id ?? ''
                const label = s.title || (s.preview ? s.preview.slice(0, 36) : key.slice(0, 18))
                const meta = [relTime(s.started_at), s.message_count ? `${s.message_count} msgs` : null].filter(Boolean).join(' · ')
                return (
                  <button
                    key={key}
                    className={`drawer-session-row ${activeSid === s.session_id ? 'active' : ''}`}
                    onClick={async () => {
                      setShowSessionsDrawer(false)
                      const r = rpc.current!
                      try {
                        const rr = await r('session.resume', { session_id: key, cols: 120 })
                        const live = rr.session_id
                        const rep = await r('session.events.since', { session_id: live, last_seen: 0 })
                        setBlocks((p) => ({ ...p, [live]: [] }))
                        setActiveSid(live)
                        for (const e of rep.events ?? []) applyEvent(e)
                      } catch { }
                    }}
                  >
                    <span className="row-title">{label}</span>
                    {meta && <span className="row-meta">{meta}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Main Canvas Scrollable Area ── */}
      <div className="canvas-scrollable">
        {/* Top Quick Task Box */}
        {!hasMessages && (
          <div className="quick-task-card">
          <textarea
            placeholder="What should Moch work on?"
            value={quickDraft}
            onChange={(e) => setQuickDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend(quickDraft)
              }
            }}
          />
          <div className="quick-task-toolbar">
            <div className="toolbar-left">
              <button className="tool-chip-btn" onClick={() => setQuickDraft((d) => `${d} [attach file]`)}>
                <IconAttach width={14} height={14} />
                <span>Attach</span>
              </button>
              <button className="tool-chip-btn" onClick={() => setQuickDraft((d) => `${d} /tools`)}>
                <IconTools width={14} height={14} />
                <span>Tools</span>
              </button>
              <button className="tool-chip-btn" onClick={() => setQuickDraft((d) => `${d} in project `)}>
                <IconFolder width={14} height={14} />
                <span>Project</span>
              </button>
            </div>
            <div className="toolbar-right">
              <div className="model-select-badge">
                <IconLock width={12} height={12} />
                <span>{modelName}</span>
                <span className="arrow">▾</span>
              </div>
              <button
                className="circular-send-btn"
                disabled={!quickDraft.trim() || busy}
                onClick={() => void handleSend(quickDraft)}
              >
                <IconSend width={14} height={14} />
              </button>
            </div>
          </div>
          </div>
        )}

        {/* Hero Empty State vs Active Message Stream */}
        {!hasMessages ? (
          <div className="hero-empty-state">
            {/* Center Hero Mochi Mascot (144px, interactive, animated) */}
            <div className="hero-mascot-wrapper">
              <div className="radial-glow-aura" />
              <MochiInteractive
                state={
                  turnMochi === 'celebration'
                    ? 'mochi-celebration'
                    : busy
                    ? 'mochi-listening'
                    : 'mochi-greeting'
                }
                size={144}
              />
            </div>

            <div className="hero-text-block">
              <h3>Ready when you are</h3>
              <p>Give me a task, ask a question, or choose a mode from the sidebar. I'll handle the rest.</p>
            </div>

            {/* Example Tasks Grid (2 columns, 6 cards) */}
            <div className="example-tasks-section">
              <div className="section-header-label">Example tasks</div>
              <div className="example-tasks-grid">
                {EXAMPLE_TASKS.map((t) => (
                  <button
                    key={t.title}
                    className="example-task-card"
                    onClick={() => {
                      setDraft(t.prompt)
                      void handleSend(t.prompt)
                    }}
                  >
                    <div className={`task-card-icon-box ${t.icon}`}>
                      {t.icon === 'code' ? <IconCoding width={16} height={16} />
                        : t.icon === 'bug' ? <IconBug width={16} height={16} />
                        : t.icon === 'research' ? <IconResearch width={16} height={16} />
                        : t.icon === 'chart' ? <IconChart width={16} height={16} />
                        : t.icon === 'folder' ? <IconFolder width={16} height={16} />
                        : <IconCalendar width={16} height={16} />}
                    </div>
                    <div className="task-card-content">
                      <span className="task-card-title">{t.title}</span>
                      <span className="task-card-desc">{t.desc}</span>
                    </div>
                    <span className="task-card-arrow">›</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="messages-stream">
            {list.map((b) =>
              b.kind === 'user' ? (
                <div key={b.id} className="msg user">{b.text}</div>
              ) : b.kind === 'assistant' ? (
                <div key={b.id} className={`msg assistant${b.live ? ' live' : ''}`}>
                  {b.live ? (b.text || '▍') : (b.text ? <Markdown text={b.text} /> : null)}
                </div>
              ) : b.kind === 'thinking' ? (
                <details key={b.id} className="thinking" open>
                  <summary>Thinking{b.live ? '…' : ''}</summary>
                  <pre>{b.text}</pre>
                </details>
              ) : b.kind === 'tool' ? (
                <div key={b.id} className="tool">
                  <span className={`dot${b.live ? '' : ' done'}`}>{b.live ? '◌' : '●'}</span>
                  {b.text}
                  {b.meta ? <span className="meta"> {b.meta}</span> : null}
                </div>
              ) : (
                <div key={b.id} className="statusline">{b.text}</div>
              )
            )}
          </div>
        )}
      </div>

      {/* ── Floating Bottom Composer ── */}
      {/* ── Floating Bottom Composer (only visible once session has messages) ── */}
      {hasMessages && (
        <div className="floating-bottom-composer">
        <div className="composer-pill-container">
          <button className="composer-action-btn plus" title="Add context or tool">
            <IconPlus width={15} height={15} />
          </button>

          {turnMochi && (
            <img
              className={`turnchip ${turnMochi === 'celebration' ? 'celebrate' : ''}`}
              src={turnMochi === 'celebration' ? '/brand/mochi-celebration.svg' : '/brand/mochi-listening.svg'}
              alt=""
            />
          )}

          <input
            type="text"
            className="composer-input"
            placeholder="Ask Moch anything..."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSend(draft)
              }
            }}
          />

          <div className="composer-right-actions">
            <div className="model-select-badge compact">
              <IconLock width={11} height={11} />
              <span>{modelName}</span>
              <span className="arrow">▾</span>
            </div>
            <button
              className="circular-send-btn"
              disabled={!draft.trim() || busy}
              onClick={() => void handleSend(draft)}
            >
              <IconSend width={14} height={14} />
            </button>
          </div>
        </div>
        </div>
      )}
    </div>
  )
}
