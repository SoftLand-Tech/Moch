/**
 * Chat / Agent Workspace — layout and components matching the dashboard mockup:
 * - Header: Mode title + subtitle
 * - Top Quick Task Box (per-mode placeholder + Send/Stop)
 * - Hero Empty State (Center Mochi mascot + "Ready when you are" + per-mode Example Tasks)
 * - Message Stream (cream user bubble, assistant markdown, thinking, tools, errors)
 * - Approval / clarify cards (server->client requests, answered over the same socket)
 * - Floating Bottom Composer (per-mode placeholder + model badge + Send/Stop)
 * - Clean session switcher pills bar; resume renders the session.resume transcript
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from '../Markdown'
import {
  IconAgent,
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
} from '../Icons'
import { ev, relTime, type Block, type RpcRef, type SessionRow } from '../types'
import type { ActiveTaskState, ActivityItem } from '../RightPanel'
import MochiInteractive from '../MochiInteractive'

/** A server->client request as handed to `client.onRequest` (json-rpc-channel.ts ServerRequest). */
type ServerRequestLike = {
  id: string
  method: string
  params: Record<string, unknown> & { session_id?: string }
  sessionId?: string
  replayed?: boolean
  respond: (result: Record<string, unknown>) => void
  fail: (code: number, message: string) => void
}

/** One pending approval/clarify question, kept OUT of the blocks map. */
type AskCard = {
  id: string
  method: 'approval' | 'clarify'
  sessionId: string
  title: string
  body: string
  choices?: string[]
  req: ServerRequestLike
}

type ExampleTask = { icon: string; title: string; desc: string; prompt: string }

const EXAMPLE_TASKS: Record<'agent' | 'chat' | 'coding' | 'research', ExampleTask[]> = {
  agent: [
    { icon: 'code', title: 'Build a Laravel feature', desc: 'Create a new feature, run tests, and push to GitHub', prompt: 'Build a Laravel feature: create a new feature, run tests, and push to GitHub.' },
    { icon: 'bug', title: 'Fix a bug', desc: 'Find the issue, fix it, and explain the changes', prompt: 'Find the bug, fix it, and explain what caused it and the changes made.' },
    { icon: 'research', title: 'Research a topic', desc: 'Find, read, and summarize the latest information', prompt: 'Research this topic: find, read, and summarize the latest findings and insights.' },
    { icon: 'chart', title: 'Analyze data', desc: 'Process data and generate insights', prompt: 'Analyze data: process the inputs and generate actionable insights and charts.' },
    { icon: 'folder', title: 'Organize my files', desc: 'Sort and clean up my project directory', prompt: 'Organize my files: sort and clean up the current project directory with best practices.' },
    { icon: 'calendar', title: 'Plan a project', desc: 'Create a step-by-step plan with milestones', prompt: 'Plan a project: create a step-by-step implementation plan with concrete milestones.' },
  ],
  chat: [
    { icon: 'research', title: 'Explain a concept', desc: 'A clear, simple answer to any question', prompt: 'Explain how large language models actually work, in plain language.' },
    { icon: 'calendar', title: 'Plan my week', desc: 'Draft a realistic schedule together', prompt: 'Help me plan a balanced week with deep work blocks, errands, and rest.' },
    { icon: 'chart', title: 'Weigh a decision', desc: 'Compare options and their tradeoffs', prompt: 'I\'m choosing between two job offers — help me think through the tradeoffs.' },
  ],
  coding: [
    { icon: 'code', title: 'Build an API endpoint', desc: 'Design, implement, and test a route', prompt: 'Build a REST endpoint for user settings: design the schema, implement it, and write tests.' },
    { icon: 'bug', title: 'Fix a failing test', desc: 'Reproduce, root-cause, and repair', prompt: 'A test in my repo is failing — reproduce it, find the root cause, fix it, and re-run the suite.' },
    { icon: 'folder', title: 'Refactor a module', desc: 'Clean up structure, keep behavior', prompt: 'Refactor the src/services module for readability while keeping all tests green.' },
  ],
  research: [
    { icon: 'research', title: 'Deep-dive a topic', desc: 'Sources, synthesis, and a briefing', prompt: 'Research the current state of solid-state batteries: key players, timelines, open problems.' },
    { icon: 'chart', title: 'Compare tools', desc: 'A side-by-side with a recommendation', prompt: 'Compare local-first note apps in 2026 and recommend one for a developer who values sync.' },
    { icon: 'folder', title: 'Summarize a paper', desc: 'Turn a dense paper into usable notes', prompt: 'Find a recent notable paper on agent memory and summarize its key findings and limits.' },
  ],
}

const MODE_PLACEHOLDERS: Record<'agent' | 'chat' | 'coding' | 'research', string> = {
  agent: 'What should Moch work on?',
  chat: 'Ask Moch anything...',
  coding: 'Describe the coding task…',
  research: 'What should I dig into?',
}

export default function ChatTab({
  rpc,
  client,
  profile,
  onProfile,
  mode = 'agent',
  onActivity,
  onTaskUpdate,
  onWorkingChange,
  searchQuery,
}: {
  rpc: RpcRef
  client: {
    onAny: (cb: (e: unknown) => void) => () => void
    onRequest: (cb: (req: ServerRequestLike) => boolean | void) => () => void
  } | null
  profile: string
  onProfile: (p: string) => void
  mode?: 'agent' | 'chat' | 'coding' | 'research'
  onActivity?: (item: ActivityItem) => void
  onTaskUpdate?: (task: ActiveTaskState | null) => void
  onWorkingChange?: (working: boolean) => void
  /** When non-empty, the sessions drawer filters rows by title/preview (case-insensitive). */
  searchQuery?: string
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
  const [asks, setAsks] = useState<AskCard[]>([])
  const [askText, setAskText] = useState('')

  const blockId = useRef(1)
  const blocksRef = useRef(blocks); blocksRef.current = blocks
  const activeRef = useRef(activeSid); activeRef.current = activeSid
  const onActivityRef = useRef(onActivity); onActivityRef.current = onActivity
  const onWorkingChangeRef = useRef(onWorkingChange); onWorkingChangeRef.current = onWorkingChange
  /** Block id -> gateway tool_id (tool.complete matches by tool_id, C5). */
  const toolIds = useRef(new Map<number, string>())
  /** Per-session busy truth; global `busy` mirrors ONLY the active session (C3/C13). */
  const busyBySess = useRef<Record<string, boolean>>({})
  /** Sessions created here without a title: refresh session.list after their first turn (C10). */
  const needsRefresh = useRef(new Set<string>())
  const celebrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)

  useEffect(() => () => { if (celebrationTimer.current) clearTimeout(celebrationTimer.current) }, [])

  // Switching sessions re-syncs global UI from the per-session truth: a
  // background session streaming must never keep a fresh chat "busy" (C13).
  useEffect(() => {
    setBusy(!!busyBySess.current[activeSid])
    setTurnMochi('')
  }, [activeSid])

  const applyBusy = (sid: string, v: boolean) => {
    busyBySess.current[sid] = v
    if (sid === activeRef.current) setBusy(v)
  }

  const fireCelebration = () => {
    if (celebrationTimer.current) clearTimeout(celebrationTimer.current)
    setTurnMochi('celebration')
    celebrationTimer.current = setTimeout(() => { celebrationTimer.current = null; setTurnMochi('') }, 2600)
  }

  const pushBlock = (sid: string, b: Omit<Block, 'id'>): Block => {
    const created = { ...b, id: blockId.current++ } as Block
    setBlocks((p) => ({ ...p, [sid]: [...(p[sid] ?? []), created] }))
    return created
  }

  const patchBlock = (sid: string, pred: (b: Block) => boolean, patch: Partial<Block> | ((b: Block) => Partial<Block>)) =>
    setBlocks((p) => {
      const list = p[sid] ?? []; const i = list.findLastIndex(pred); if (i < 0) return p
      const next = list.slice(); next[i] = { ...next[i], ...(typeof patch === 'function' ? patch(next[i]) : patch) }
      return { ...p, [sid]: next }
    })

  /** Subtitle for a tool row, derived from the gateway payload's args (C6):
   *  {tool_id, name, context, args, args_text, preview} — never p.input.*. */
  const toolSubtitle = (p: Record<string, unknown> | undefined): string => {
    if (!p) return ''
    if (typeof p.preview === 'string' && p.preview) return p.preview.slice(0, 48)
    if (typeof p.args_text === 'string' && p.args_text) return p.args_text.slice(0, 48)
    const raw = p.args
    let a: Record<string, unknown> | null = null
    if (raw && typeof raw === 'object') a = raw as Record<string, unknown>
    else if (typeof raw === 'string' && raw.trim()) {
      try { const j = JSON.parse(raw); if (j && typeof j === 'object') a = j as Record<string, unknown> } catch { return raw.slice(0, 48) }
    }
    if (a) {
      for (const k of ['command', 'path', 'query', 'url']) {
        const v = a[k]
        if (typeof v === 'string' && v) return v.slice(0, 48)
        if (Array.isArray(v) && v.length) return v.filter((x) => typeof x === 'string').join(' ').slice(0, 48)
      }
    }
    return ''
  }

  /** session.resume transcript -> blocks (C1). Roles map user/assistant like the
   *  phone's applyHistory (chat.ts:1681); durable reasoning becomes a closed thinking block. */
  const transcriptToBlocks = (messages?: Array<Record<string, unknown>>): Block[] => {
    const out: Block[] = []
    for (const m of messages ?? []) {
      const role = String(m?.role ?? '') === 'user' ? 'user' : 'assistant'
      const raw = m?.content ?? m?.text ?? ''
      const text = typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
      if (text === '[object Object]') continue
      if (role === 'assistant') {
        const reasoning = typeof m?.reasoning === 'string' ? m.reasoning : typeof m?.reasoning_content === 'string' ? m.reasoning_content : ''
        if (reasoning.trim()) out.push({ id: blockId.current++, kind: 'thinking', text: reasoning, live: false })
      }
      if (!text.trim()) continue
      out.push({ id: blockId.current++, kind: role, text, live: false })
    }
    return out
  }

  const applyEvent = useCallback((e: unknown) => {
    const { type, session_id: sid, payload: p } = ev(e)
    if (!sid) return
    const active = sid === activeRef.current
    const last = (pred: (b: Block) => boolean) => (blocksRef.current[sid] ?? []).findLast(pred)

    switch (type) {
      case 'message.start':
        pushBlock(sid, { kind: 'assistant', text: '', live: true })
        applyBusy(sid, true)
        if (active) { setTurnMochi('listening'); onWorkingChangeRef.current?.(true) }
        break
      // C8: 'message.interim' is ignored entirely — the phone drops it too
      // (it duplicates text that message.delta already delivered).
      case 'message.delta': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'assistant' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: b.text + text }))
        else pushBlock(sid, { kind: 'assistant', text, live: true })
        break
      }
      case 'message.complete': {
        const failed = p?.status === 'error' || !!p?.error
        patchBlock(sid, (b) => b.kind === 'assistant' && b.live, (b: Block) => ({ live: false, text: p?.text != null && String(p.text) ? String(p.text) : b.text }))
        patchBlock(sid, (b) => b.kind === 'thinking' && b.live, { live: false })
        if (failed) pushBlock(sid, { kind: 'error', text: String(p?.error ?? p?.failure_reason ?? 'Turn failed') })
        applyBusy(sid, false)
        if (active) {
          if (failed) setTurnMochi('')
          else fireCelebration()
          onWorkingChangeRef.current?.(false)
        }
        // C10: first turn of an untitled local session landed — silently refresh the drawer.
        if (needsRefresh.current.has(sid)) {
          needsRefresh.current.delete(sid)
          void loadSessions(profRef.current)
        }
        break
      }
      // C7: the agent's main reasoning stream arrives as reasoning.delta.
      case 'thinking.delta':
      case 'reasoning.delta': {
        const text = String(p?.text ?? p?.delta ?? ''); if (!text) break
        const t = last((b) => b.kind === 'thinking' && b.live)
        if (t) patchBlock(sid, (b) => b.id === t.id, (b: Block) => ({ text: b.text + text }))
        else pushBlock(sid, { kind: 'thinking', text, live: true })
        break
      }
      case 'tool.start': {
        const toolName = String(p?.name ?? p?.tool ?? 'tool')
        const tid = String(p?.tool_id ?? '')
        const sub = toolSubtitle(p)
        const created = pushBlock(sid, { kind: 'tool', text: toolName, live: true, meta: sub || undefined })
        if (tid) toolIds.current.set(created.id, tid)
        if (active) {
          onActivityRef.current?.({
            id: Date.now() + Math.random(),
            kind: toolName.includes('file') || toolName.includes('read') ? 'file' : toolName.includes('bash') || toolName.includes('terminal') ? 'command' : toolName.includes('search') ? 'search' : 'tool',
            title: toolName.includes('read') ? 'Read file' : toolName.includes('write') ? 'Write file' : toolName.includes('bash') ? 'Run command' : toolName.includes('search') ? 'Search' : `Execute ${toolName}`,
            subtitle: sub || toolName,
            time: 'just now',
          })
        }
        break
      }
      case 'tool.complete': {
        // C5: match by the gateway's tool_id; duration arrives in SECONDS.
        const tid = String(p?.tool_id ?? '')
        const failed = p?.status === 'failed' || !!p?.error
        const dur = typeof p?.duration_s === 'number' ? p.duration_s : null
        const durTxt = dur != null ? `${dur < 10 ? dur.toFixed(1) : String(Math.round(dur))}s` : null
        patchBlock(
          sid,
          (b) => b.kind === 'tool' && b.live && (!tid || toolIds.current.get(b.id) === tid),
          { live: false, meta: [failed ? 'failed' : null, durTxt].filter(Boolean).join(' · ') || undefined },
        )
        break
      }
      case 'status.update': {
        // Wire payload is {kind, text} (tui_gateway/contracts/events.py). A busy
        // edge reconciles the active session's spinner; anything else is a status line.
        if (p?.kind === 'busy') {
          if (active && p?.busy === false) { applyBusy(sid, false); setTurnMochi(''); onWorkingChangeRef.current?.(false) }
          break
        }
        const text = String(p?.text ?? ''); if (!text) break
        pushBlock(sid, { kind: 'status', text })
        break
      }
      case 'error': {
        // Terminal path: freeze the live tail, surface the failure, clear busy.
        const msg = String(p?.message ?? p?.error ?? 'Gateway error')
        patchBlock(sid, (b) => (b.kind === 'assistant' || b.kind === 'thinking') && b.live, (b: Block) => (b.kind === 'assistant' && !b.text ? { live: false, text: msg } : { live: false }))
        pushBlock(sid, { kind: 'error', text: msg })
        applyBusy(sid, false)
        if (active) { setTurnMochi(''); onWorkingChangeRef.current?.(false) }
        break
      }
    }
  }, [])

  const loadSessions = useCallback(async (prof: string) => {
    const r = rpc.current; if (!r) return
    try {
      const res = await r<{ sessions?: SessionRow[]; items?: SessionRow[] }>('session.list', prof && prof !== 'default' ? { limit: 200, profile: prof } : { limit: 200 })
      const rows: SessionRow[] = Array.isArray(res) ? res : res.sessions ?? res.items ?? []
      setSessions(rows.filter((s) => s.id ?? s.stored_session_id ?? s.session_id))
    } catch { }
  }, [rpc])

  const loadRoster = useCallback(async () => {
    const r = rpc.current; if (!r) return
    try {
      const res = await r<{ profiles?: Array<{ name: string }>; items?: Array<{ name: string }> }>('profiles.list', {})
      const rows = res.profiles ?? res.items ?? []
      setRoster(rows.map((p: { name: string }) => p.name).filter((n: string) => n && n !== 'default'))
    } catch { }
  }, [rpc])

  // Display-only badge: the configured default model, from model.options
  // (config.get is not a gateway RPC). Prefer the response's top-level model,
  // else default/model on the authenticated provider (modelState.ts shapes).
  useEffect(() => {
    if (!rpc.current) return
    rpc.current('model.options', {})
      .then((r: unknown) => {
        const o = (r && typeof r === 'object' ? r : {}) as { model?: unknown; providers?: unknown }
        let name = typeof o.model === 'string' && o.model ? o.model : ''
        const provs = Array.isArray(o.providers) ? (o.providers as Array<Record<string, unknown>>) : []
        const authed = provs.find((x) => x?.authenticated === true)
        if (!name && authed) {
          const d = authed.default ?? authed.model
          if (typeof d === 'string' && d) name = d
        }
        if (name) setModelName(name.split('/').pop() || name)
      })
      .catch(() => {})
  }, [rpc])

  // C2: answer server->client requests instead of letting the channel
  // auto-decline everything with -32601. Cards live in local state.
  useEffect(() => {
    if (!client) return
    const off = client.onRequest((req) => {
      const method = String(req?.method ?? '')
      if (method !== 'approval' && method !== 'clarify') {
        // Preserve the channel's default answer for anything not rendered here.
        req.fail(-32601, `no handler for server request: ${method}`)
        return true
      }
      const sid = req.sessionId || activeRef.current
      if (!sid) return false // unaddressable: channel answers -32601 (phone BUG-067)
      const p = req.params ?? {}
      const card: AskCard = method === 'approval'
        ? {
            id: req.id, method, sessionId: sid,
            title: typeof p.tool_name === 'string' && p.tool_name ? p.tool_name : 'Approval needed',
            body: (typeof p.command === 'string' && p.command ? p.command : typeof p.description === 'string' && p.description ? p.description : 'The agent wants to run a command.').slice(0, 800),
            req,
          }
        : {
            id: req.id, method, sessionId: sid,
            title: 'Mochi needs you',
            body: (typeof p.question === 'string' && p.question ? p.question : 'Clarification needed').slice(0, 1000),
            choices: Array.isArray(p.choices) ? p.choices.map(String).slice(0, 12) : undefined,
            req,
          }
      setAsks((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, card]))
      return true
    })
    return off
  }, [client])

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

  const answerAsk = (card: AskCard, result: Record<string, unknown>) => {
    card.req.respond(result)
    setAsks((prev) => prev.filter((c) => c.id !== card.id))
  }
  const cancelAsk = (card: AskCard) => {
    card.req.fail(-32601, `${card.method} cancelled by user`)
    setAsks((prev) => prev.filter((c) => c.id !== card.id))
  }

  const handleStop = async () => {
    const sid = activeRef.current
    if (!sid) return
    // Same params as the phone's stopRun (chat.ts:2062): { session_id }.
    try {
      await rpc.current?.('session.interrupt', { session_id: sid })
      // BUG-047 parity: only declare idle when the interrupt landed; turn-end
      // events reconcile the UI either way.
      applyBusy(sid, false)
      if (sid === activeRef.current) { setTurnMochi(''); onWorkingChangeRef.current?.(false) }
    } catch (err) {
      console.error('interrupt failed:', err)
    }
  }

  const handleSend = async (customText?: string) => {
    const text = (customText ?? draft ?? quickDraft).trim()
    if (!text || busy) return
    const r = rpc.current!; setDraft(''); setQuickDraft(''); applyBusy(activeRef.current, true)
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

    let sid = activeRef.current
    try {
      if (!sid) {
        // C10: no create-time title — a manual title permanently blocks the
        // server's auto-titling. C15: source 'desktop'.
        const cr = await r<{ session_id: string }>('session.create', {
          cols: 120,
          source: 'desktop',
          ...(prof ? { profile: prof, follow_profile_config: true } : {}),
        })
        sid = cr.session_id
        activeRef.current = sid
        setBlocks((p) => ({ ...p, [sid]: [{ id: blockId.current++, kind: 'user', text }] }))
        setActiveSid(sid)
        busyBySess.current[''] = false
        needsRefresh.current.add(sid)
        setSessions((p) => [
          { session_id: sid, title: 'New chat', started_at: Date.now() / 1000, profile: prof },
          ...p,
        ])
      } else {
        pushBlock(sid, { kind: 'user', text })
      }

      await r('prompt.submit', { session_id: sid, text })
    } catch (err) {
      // C19: a failed submit is never silent.
      console.error('prompt.submit failed:', err)
      if (sid) pushBlock(sid, { kind: 'error', text: `Failed to send: ${err instanceof Error ? err.message : String(err)}` })
      applyBusy(sid, false)
      onWorkingChangeRef.current?.(false)
    }
  }

  // C11: stick to the bottom only while the user is already near it.
  useEffect(() => {
    const el = streamRef.current
    if (!el || !nearBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [blocks, activeSid])

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
  const placeholder = MODE_PLACEHOLDERS[mode] || MODE_PLACEHOLDERS.agent
  const examples = EXAMPLE_TASKS[mode] || EXAMPLE_TASKS.agent

  // C16: optional drawer filtering by title/preview.
  const visibleSessions = useMemo(() => {
    const q = (searchQuery ?? '').trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => `${s.title ?? ''} ${s.preview ?? ''}`.toLowerCase().includes(q))
  }, [sessions, searchQuery])

  const copyChip = (text: string) => (
    <button
      title="Copy"
      onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}) }}
      style={{
        marginLeft: 8, padding: '1px 8px', fontSize: 10.5, lineHeight: '16px',
        borderRadius: 999, border: '1px solid rgba(128,128,128,.35)', background: 'transparent',
        color: 'inherit', opacity: 0.55, cursor: 'pointer', verticalAlign: 'middle',
      }}
      onMouseOver={(e) => { e.currentTarget.style.opacity = '1' }}
      onMouseOut={(e) => { e.currentTarget.style.opacity = '0.55' }}
    >
      Copy
    </button>
  )

  const renderAskCard = (card: AskCard) => (
    <div
      key={card.id}
      style={{
        margin: '0 auto 10px', maxWidth: 720, borderRadius: 14, padding: '10px 12px',
        border: '1px solid rgba(255,176,32,.45)', background: 'rgba(255,176,32,.08)',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
        <IconLock width={12} height={12} />
        <span>{card.method === 'approval' ? card.title : 'Mochi needs you'}</span>
      </div>
      <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.85, maxHeight: 140, overflow: 'auto' }}>
        {card.body}
      </div>
      {card.method === 'approval' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="tool-chip-btn"
            style={{ background: 'rgba(48,164,108,.9)', color: '#fff', border: 'none' }}
            onClick={() => answerAsk(card, { choice: 'once', all: undefined })}
          >
            Approve
          </button>
          <button
            className="tool-chip-btn"
            style={{ color: '#e5484d' }}
            onClick={() => answerAsk(card, { choice: 'deny', all: undefined })}
          >
            Deny
          </button>
        </div>
      ) : (
        <>
          {(card.choices ?? []).map((o) => (
            <button
              key={o}
              className="tool-chip-btn"
              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => answerAsk(card, { answer: o })}
            >
              {o}
            </button>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              className="composer-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Or type your answer…"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const t = askText.trim().slice(0, 4000)
                  if (t) { setAskText(''); answerAsk(card, { answer: t }) }
                }
              }}
            />
            <button
              className="tool-chip-btn"
              disabled={!askText.trim()}
              style={{ opacity: askText.trim() ? 1 : 0.5 }}
              onClick={() => {
                const t = askText.trim().slice(0, 4000)
                if (!t) return
                setAskText('')
                answerAsk(card, { answer: t })
              }}
            >
              Send
            </button>
            <button className="tool-chip-btn" onClick={() => cancelAsk(card)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )

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

          {visibleSessions.length > 0 && (
            <button
              className={`session-pill-btn drawer-toggle ${showSessionsDrawer ? 'active' : ''}`}
              onClick={() => setShowSessionsDrawer((v) => !v)}
            >
              {visibleSessions.length} chats ▾
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
              {visibleSessions.map((s) => {
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
                        // C1: render the transcript session.resume RETURNS — the
                        // gateway's event ring is a capped FIFO (512) and misses
                        // long history. Live tail rides the socket as usual.
                        const rr = await r<{
                          session_id?: string
                          stored_session_id?: string
                          messages?: Array<Record<string, unknown>>
                          running?: boolean
                          truncated?: boolean
                        }>('session.resume', { session_id: key, cols: 120 })
                        const live = rr.session_id
                        if (!live) return
                        setActiveSid(live)
                        busyBySess.current[live] = rr.running === true
                        setBusy(rr.running === true)
                        onWorkingChangeRef.current?.(rr.running === true)
                        const restored = transcriptToBlocks(rr.messages)
                        if (rr.truncated) {
                          restored.unshift({ id: blockId.current++, kind: 'status', text: 'Earlier messages truncated — showing the most recent history.' })
                        }
                        setBlocks((p) => ({ ...p, [live]: restored }))
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
            placeholder={placeholder}
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
              {busy && (
                <button className="tool-chip-btn" style={{ color: '#e5484d' }} onClick={() => void handleStop()}>
                  ■ Stop
                </button>
              )}
            </div>
            <div className="toolbar-right">
              <div className="model-select-badge">
                <IconLock width={12} height={12} />
                <span>{modelName}</span>
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

            {/* Example Tasks Grid (per mode) */}
            <div className="example-tasks-section">
              <div className="section-header-label">Example tasks</div>
              <div className="example-tasks-grid">
                {examples.map((t) => (
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
          <div
            className="messages-stream"
            ref={streamRef}
            onScroll={() => {
              const el = streamRef.current
              if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
            }}
          >
            {list.map((b) =>
              b.kind === 'user' ? (
                <div key={b.id} className="msg user">{b.text}{copyChip(b.text)}</div>
              ) : b.kind === 'assistant' ? (
                <div key={b.id} className={`msg assistant${b.live ? ' live' : ''}`}>
                  {b.live ? (b.text || '▍') : (b.text ? <Markdown text={b.text} /> : null)}
                  {!b.live && b.text ? copyChip(b.text) : null}
                </div>
              ) : b.kind === 'thinking' ? (
                <details key={b.id} className="thinking" open={b.live}>
                  <summary>Thinking{b.live ? '…' : ''}</summary>
                  <pre>{b.text}</pre>
                </details>
              ) : b.kind === 'tool' ? (
                <div key={b.id} className="tool">
                  <span className={`dot${b.live ? '' : ' done'}`}>{b.live ? '◌' : '●'}</span>
                  {b.text}
                  {b.meta ? <span className="meta"> {b.meta}</span> : null}
                </div>
              ) : b.kind === 'error' ? (
                <div
                  key={b.id}
                  className="statusline"
                  style={{ color: '#e5484d', border: '1px solid rgba(229,72,77,.4)', background: 'rgba(229,72,77,.08)', whiteSpace: 'pre-wrap' }}
                >
                  {b.text}
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
          {asks.filter((c) => c.sessionId === activeSid).map(renderAskCard)}
        <div className="composer-pill-container">
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
            placeholder={placeholder}
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
            {busy && (
              <button className="tool-chip-btn" style={{ color: '#e5484d' }} onClick={() => void handleStop()}>
                ■ Stop
              </button>
            )}
            <div className="model-select-badge compact">
              <IconLock width={11} height={11} />
              <span>{modelName}</span>
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
