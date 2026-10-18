import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Brain, ChevronRight, CircleStop, Copy, ListTodo,
  Mic, Paperclip, Sparkles, GitCompare, Wrench, Check, Volume2, Cpu, GraduationCap,
  SquareTerminal,
} from 'lucide-react'
import {
  activeSession, activeSessionAtom, activeTitle, agentBusy, deleteSession,
  interrupt, messages, newChat, pendingRequest, renameSession, send, sessionOrder,
  sessionsById, steer, switchToSession, toggleMark,
  tools as toolsAtom, todos as todosAtom,
  phaseForTools,
  changedFiles,
  type ChatMessage, type ChatSegment, type ToolItem,
} from '../lib/chat'
import { accentFor, activeBotName, setActiveBot } from '../lib/fleet'
import { isConnected } from '../lib/gateway'
import { renderMarkdown } from '../lib/markdown'
import { commandCatalog, completeSlash, dispatchSlash, refreshCommandCatalog } from '../lib/slash'
import { currentModel, providers, refreshModels } from '../lib/model'
import { startRecording, stopRecording } from '../lib/voice'
import { attachFiles } from '../lib/media'
import InteractiveCard from '../components/InteractiveCard'
import Mochi from '../components/Mochi'

export default function ChatView() {
  const connected = useStore(isConnected)

  useEffect(() => {
    if (connected) {
      void refreshCommandCatalog()
      void refreshModels()
    }
  }, [connected])

  return (
    <main className="focus">
      <Transcript />
      <Composer />
    </main>
  )
}

function Transcript() {
  const msgs = useStore(messages)
  const toolsList = useStore(toolsAtom)
  const todosList = useStore(todosAtom)
  const card = useStore(pendingRequest)
  const busy = useStore(agentBusy)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [msgs, toolsList, todosList, card])

  // Turn grouping: a turn starts at each user message; its tools are the
  // ones recorded after that point (history resumes without tool detail).
  const turnStart = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') return i
    }
    return -1
  }, [msgs])
  const turnTools = useMemo(() => (turnStart >= 0 ? toolsList : []), [toolsList, turnStart])
  const phase = phaseForTools(turnTools)
  const editTools = turnTools.filter((t) => t.editPath && (t.add || t.del))

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      {msgs.length === 0 && !busy ? <EmptyChat /> : null}
      {todosList.length ? (
        <div className="todos">
          <div className="todo-row" style={{ fontWeight: 650, color: 'var(--text-dim)', fontSize: 12 }}>
            <ListTodo size={13} /> Plan
          </div>
          {todosList.map((t, i) => (
            <div key={i} className={`todo-row${t.status === 'completed' ? ' done' : ''}${t.status === 'in_progress' ? ' now' : ''}`}>
              <span>{t.status === 'completed' ? <Check size={13} color="var(--green-soft)" /> : t.status === 'in_progress' ? <ChevronRight size={13} color="var(--accent)" /> : <span style={{ width: 13, display: 'inline-block' }} />}</span>
              {t.content}
            </div>
          ))}
        </div>
      ) : null}

      {msgs.map((m, i) => {
        const isCurrentTurnStart = i === turnStart
        return (
          <div key={m.id}>
            {isCurrentTurnStart && (turnTools.length > 0 || busy) ? (
              <TurnHeader phase={busy ? phase : 'Edited'} time={new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
            ) : null}
            <MessageRow msg={m} />
            {isCurrentTurnStart && turnTools.length ? <ThinkChecklist tools={turnTools} /> : null}
            {isCurrentTurnStart && editTools.length ? (
              editTools.map((t) => <DiffBlock key={`d-${t.id}`} path={t.editPath!} add={t.add ?? 0} del={t.del ?? 0} src={t.output ?? ''} />)
            ) : null}
            {m.role === 'assistant' && !m.streaming && i === msgs.length - 1 ? (
              <div className="msgfoot">
                <span onClick={() => void navigator.clipboard.writeText(turnText(msgs, i))}>⧉ copy</span>
                <span onClick={() => void speak(turnText(msgs, i))}>♪ listen</span>
                <span onClick={teachSkill}>✎ save as skill</span>
                <span onClick={() => { const lastU = findLastIdxLocal(msgs, (x: ChatMessage) => x.role === 'user'); if (lastU >= 0) void send(msgs[lastU].segments.map((sg) => sg.text).join('')) }}>↻ retry</span>
              </div>
            ) : null}
          </div>
        )
      })}

      {card ? <InteractiveCard card={card} /> : null}
      {busy && !msgs.some(m => m.streaming) ? (
        <div className="busy-strip"><div className="spinner" style={{ width: 12, height: 12 }} /> thinking…</div>
      ) : null}
    </div>
  )
}

function TurnHeader({ phase, time }: { phase: string; time: string }) {
  return (
    <div className="turnhead">
      <span className="tav">MO</span>
      <b>Mochi</b>
      <span className="phase"><span className="plamp" /> {phase}</span>
      <span className="ttime">{time}</span>
    </div>
  )
}

/** Thinking block with the turn's tool checklist inside (the mock's
    "Planning & analysis" pattern: evidence rows with timings). */
function ThinkChecklist({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(true)
  const last = tools[tools.length - 1]
  const anyRunning = tools.some((t) => t.status === 'running')
  const totalSec = tools.reduce((n, t) => n + (t.endedAt && t.startedAt ? (t.endedAt - t.startedAt) / 1000 : 0), 0)
  return (
    <div className="think">
      <div className="think-head" onClick={() => setOpen(v => !v)}>
        <Brain size={13} />
        <span>{anyRunning ? (last?.name ? `Working — ${last.name}` : 'Thinking') : 'Planning & analysis'}</span>
        {anyRunning ? <span className="think-dots"><span /><span /><span /></span> : null}
        <span className="text-faint" style={{ fontSize: 10.5, marginLeft: 4, fontFamily: 'var(--font-mono)' }}>{totalSec.toFixed(1)}s</span>
        <ChevronRight size={13} style={{ marginLeft: 'auto', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
      </div>
      {open ? (
        <div className="think-body" style={{ maxHeight: 260 }}>
          {tools.map((t) => (
            <div key={t.id} className="ckrow">
              <span className="ckgl">{t.status === 'running' ? <span className="spinner" style={{ width: 9, height: 9 }} /> : t.status === 'error' ? <span style={{ color: 'var(--red)' }}>✗</span> : <Check size={12} color="var(--green)" />}</span>
              <b>{phaseVerb(t.name)}</b>
              <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 11 }}>{argsShort(t)}</span>
              {t.endedAt && t.startedAt ? <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{((t.endedAt - t.startedAt) / 1000).toFixed(1)}s</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function phaseVerb(name: string): string {
  const n = name.toLowerCase()
  if (/read/.test(n)) return 'Read'
  if (/patch|edit|apply/.test(n)) return 'Edited'
  if (/write_file/.test(n)) return 'Wrote'
  if (/terminal|bash|exec/.test(n)) return 'Ran'
  if (/browser/.test(n)) return 'Browsed'
  if (/search/.test(n)) return 'Searched'
  return name
}

function argsShort(t: ToolItem): string {
  if (!t.args) return ''
  try {
    const a = JSON.parse(t.args) as Record<string, unknown>
    const p = a.path ?? a.file ?? a.command ?? a.url ?? ''
    return String(p).slice(0, 60)
  } catch {
    return t.args.slice(0, 60)
  }
}

/** Inline diff block (the mock's docs/index.html +38 −12 card). */
function DiffBlock({ path, add, del, src }: { path: string; add: number; del: number; src: string }) {
  const [open, setOpen] = useState(true)
  const lines = src ? src.split('\n').slice(0, 24) : []
  return (
    <div className="diffcard">
      <div className="diffhead">
        <span className="mono">{path.split('/').pop()}</span>
        <span className="dnum"><span className="add">+{add}</span> <span className="del">−{del}</span></span>
        <span className="viewdiff" onClick={() => setOpen(v => !v)}>View diff <ChevronRight size={10} style={{ transform: open ? 'rotate(90deg)' : 'none' }} /></span>
      </div>
      {open ? (
        <div className="diffln">
          {lines.map((l, i) => (
            <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx'}>{l}</span>
          ))}
          {lines.length === 0 ? <span className="ctx">(diff preview unavailable)</span> : null}
        </div>
      ) : null}
      <div className="difffoot">
        <span className="mono" style={{ fontSize: 10.5 }}>{path}</span>
        <span style={{ flex: 1 }} />
        <span className="dact">Open</span>
        <span className="dact" onClick={() => navigator.clipboard.writeText(src)}>Copy</span>
        <span className="dact apply">Apply</span>
      </div>
    </div>
  )
}

function EmptyChat() {
  return (
    <div className="empty" style={{ padding: '60px 20px' }}>
      <Mochi mood="greeting" size={88} />
      <div className="empty-title">What should Mochi do?</div>
      <div className="empty-sub">
        Your agents run entirely on this machine — they can use the terminal, browse the web,
        remember across chats, and work while you're elsewhere. Ask for anything.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
        {['What can you do?', 'Look up something in the browser', 'Set up an automation', 'Show me the workspace'].map(s => (
          <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>
        ))}
      </div>
    </div>
  )
}

function MessageRow({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-user-bubble">{msg.segments.map((s, i) => <span key={i}>{s.text}</span>)}</div>
      </div>
    )
  }
  if (msg.role === 'system') {
    return <div className="msg"><div className="msg-sys">{msg.segments.map((s, i) => <span key={i}>{s.text}</span>)}</div></div>
  }
  const reasoning = msg.segments.filter((s) => s.kind === 'reasoning')
  const text = msg.segments.filter((s) => s.kind === 'text')
  const streaming = msg.streaming
  return (
    <div className="msg assistant">
      {reasoning.map((s, i) => <ThinkBlock key={i} seg={s} streaming={!!streaming && i === reasoning.length - 1 && text.length === 0} />)}
      {text.map((s, i) => (
        <div key={i} className="msg-assistant-body md">
          {streaming && i === text.length - 1 ? s.text : <span dangerouslySetInnerHTML={{ __html: renderMarkdown(s.text) }} />}
        </div>
      ))}

    </div>
  )
}

function teachSkill(): void {
  const name = prompt('Name this skill (a short slug, e.g. release-checklist)')
  if (!name) return
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!slug) return
  void send(
    `Please distill what you learned in this conversation into a reusable skill named "${slug}". ` +
    `Use the skill_manage tool to create it: the skill should describe WHEN to use it, the exact steps ` +
    `as performed here (including any corrections I made), inputs to ask for, and failure notes. ` +
    `Confirm with the skill's path when saved.`,
  )
}

async function speak(text: string): Promise<void> {
  try {
    const { gwFetch } = await import('../lib/gateway')
    const res = (await gwFetch('/api/audio/speak', {
      method: 'POST',
      body: JSON.stringify({ text }),
      contentType: 'application/json',
    })) as string
    const payload = JSON.parse(res || '{}') as { ok?: boolean; data_url?: string }
    if (!payload.data_url) throw new Error('tts returned no audio')
    const audio = new Audio(payload.data_url)
    await audio.play()
  } catch (err) {
    console.warn('[tts]', err)
  }
}

function ThinkBlock({ seg, streaming }: { seg: ChatSegment; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - (seg.startedAt ?? Date.now())) / 1000)), 1000)
    return () => clearInterval(t)
  }, [streaming, seg.startedAt])

  const kind = seg.kind === 'thinking' ? 'Thinking' : 'Reasoning'
  return (
    <div className="think">
      <div className="think-head" onClick={() => setOpen(v => !v)}>
        <Brain size={13} />
        <span>{kind}{streaming ? '' : ` · ${seg.text.length} chars`}</span>
        {streaming ? (
          <>
            <span className="think-dots"><span /><span /><span /></span>
            <span className="text-faint" style={{ marginLeft: 4 }}>{elapsed}s</span>
          </>
        ) : null}
        <ChevronRight size={13} style={{ marginLeft: 'auto', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
      </div>
      {open ? <div className="think-body">{seg.text}</div> : null}
    </div>
  )
}

function ToolRow({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false)
  const status = tool.status === 'running' ? <span className="tool-status run"><div className="spinner" style={{ width: 10, height: 10 }} /></span>
    : tool.status === 'error' ? <span className="tool-status err">failed</span>
      : <span className="tool-status ok"><Check size={11} /></span>
  return (
    <>
      <div className="toolrow" onClick={() => setOpen(v => !v)}>
        <Wrench size={13} color="var(--acc2)" />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-args">{tool.args}</span>
        {tool.endedAt && tool.startedAt ? <span className="row-meta">{((tool.endedAt - tool.startedAt) / 1000).toFixed(1)}s</span> : null}
        {status}
      </div>
      {open ? (
        <div className="tool-detail">
          {tool.args ? `▸ args\n${tool.args}\n\n` : ''}
          {tool.output ? `▸ output\n${tool.output}` : tool.status === 'running' ? 'running…' : ''}
        </div>
      ) : null}
    </>
  )
}

function Composer() {
  const [text, setText] = useState('')
  const [steerMode, setSteerMode] = useState(false)
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [slashSel, setSlashSel] = useState(0)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const busy = useStore(agentBusy)
  const active = useStore(activeSession)
  const botName = useStore(activeBotName)
  const catalog = useStore(commandCatalog)
  const model = useStore(currentModel)
  const provs = useStore(providers)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const completions = useMemo(() => completeSlash(text, catalog), [text, catalog])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [text])

  useEffect(() => setSlashSel(0), [text])

  const submit = async () => {
    const t = text.trim()
    if (!t && pendingFiles.length === 0) return
    if (sending) return
    setSending(true)
    try {
      if (t.startsWith('/')) {
        const handled = await dispatchSlash(t).catch(() => false)
        if (handled) {
          setText('')
          return
        }
        if (t.trim() === '/model' || t.startsWith('/model ')) {
          setModelPickerOpen(true)
          setText('')
          return
        }
      }
      if (pendingFiles.length) {
        const sid = activeSessionAtom.get() ?? (await newChat().catch(() => null))
        if (!sid) return
        const ok = await attachFiles(sid, pendingFiles).catch(() => false)
        setPendingFiles([])
        if (!ok) return
      }
      setText('')
      if (steerMode) void steer(t)
      else void send(t)
    } finally {
      setSending(false)
    }
  }

  const onVoice = () => {
    if (recording) {
      stopRecording()
      return
    }
    setVoiceError(null)
    void startRecording((s) => {
      setRecording(s.recording)
      setLevel(s.level)
      if (s.error) setVoiceError(s.error)
      const transcript = (s as { transcript?: string }).transcript
      if (transcript) setText((prev) => (prev ? `${prev} ${transcript}` : transcript))
    })
  }

  return (
    <div className="composer-wrap">
      {completions.length > 0 && text.startsWith('/') && !text.includes('\n') ? (
        <div className="slash-pop">
          {completions.map((c, i) => (
            <div
              key={c.command.name}
              className={`row${i === slashSel ? ' active' : ''}`}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => {
                if (c.command.options) {
                  setModelPickerOpen(true)
                  setText('')
                } else {
                  setText(c.command.name + ' ')
                  taRef.current?.focus()
                }
              }}
            >
              <Sparkles size={13} color="var(--acc2)" />
              <span className="row-title mono" style={{ fontSize: 12.5 }}>{c.command.name}</span>
              <span className="row-sub">{c.command.description}</span>
            </div>
          ))}
        </div>
      ) : null}
      {pendingFiles.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', maxWidth: 860 }}>
          {pendingFiles.map((f, i) => (
            <span key={i} className="chip" title={f.name}>
              <Paperclip size={11} /> {f.name.slice(0, 24)}{f.name.length > 24 ? '…' : ''}
              <button style={{ marginLeft: 2, color: 'var(--text-faint)' }} onClick={() => setPendingFiles(pendingFiles.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      {voiceError ? <div style={{ color: 'var(--red)', fontSize: 11, marginBottom: 4 }}>{voiceError}</div> : null}
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={steerMode ? 'Steer the running turn — delivered at the next boundary…' : botName ? `Ask ${botName} anything…` : 'Ask Mochi anything…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (completions.length > 0 && ['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key)) {
              e.preventDefault()
              if (e.key === 'ArrowDown') setSlashSel(s => Math.min(s + 1, completions.length - 1))
              else if (e.key === 'ArrowUp') setSlashSel(s => Math.max(s - 1, 0))
              else {
                const c = completions[slashSel]
                if (c.command.options) { setModelPickerOpen(true); setText('') }
                else setText(c.command.name + ' ')
              }
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="cbar2">
          <button className="composer-chip" onClick={() => setModelPickerOpen(true)} title="Model">
            <Cpu size={12} /> {model.model ?? 'model'} <span style={{ opacity: .6 }}>⌄</span>
          </button>
          <button className="composer-chip" title="Active agent" onClick={() => window.dispatchEvent(new CustomEvent('moch-navigate', { detail: 'fleet' }))}>
            @ {botName ?? 'Mochi'}
          </button>
          <button className="composer-chip" title="Slash commands" onClick={() => { setText('/'); taRef.current?.focus() }}>Tools</button>
          <button className="composer-chip" title="Open the terminal workbench" onClick={() => window.dispatchEvent(new CustomEvent('moch-workbench', { detail: 'terminal' }))}>
            <SquareTerminal size={12} /> Code
          </button>
          {busy ? (
            <button className="composer-chip" onClick={() => void interrupt()} title="Stop the running turn">
              <CircleStop size={12} /> stop
            </button>
          ) : null}
          <div style={{ flex: 1 }} />
          <button
            className={`composer-chip${recording ? ' accent' : ''}`}
            onClick={onVoice}
            title={recording ? 'Stop and transcribe' : 'Dictate — transcribed through your gateway'}
          >
            {recording
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="status-dot warn" style={{ margin: 0, transform: `scale(${1 + level * 1.2})`, transition: 'transform 80ms' }} /> {Math.round(level * 100)}%</span>
              : <Mic size={12} />}
          </button>
          <button className="composer-send" onClick={() => void submit()} disabled={(!text.trim() && pendingFiles.length === 0) || sending} aria-label="Send">
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      {modelPickerOpen ? (
        <ModelPicker onClose={() => setModelPickerOpen(false)} providers={provs} />
      ) : null}
    </div>
  )
}

function ModelPicker({ onClose, providers: provs }: { onClose: () => void; providers: { slug: string; name?: string; authenticated?: boolean; models: { id: string; label?: string }[] }[] }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const flat = useMemo(() => {
    const rows: { provider: string; providerName?: string; model: string; authenticated?: boolean }[] = []
    for (const p of provs) {
      for (const m of p.models) rows.push({ provider: p.slug, providerName: p.name, model: m.id, authenticated: p.authenticated })
    }
    const needle = q.trim().toLowerCase()
    return needle ? rows.filter((r) => r.model.toLowerCase().includes(needle) || r.provider.toLowerCase().includes(needle)) : rows
  }, [provs, q])

  const pick = async (provider: string, model: string) => {
    setBusy(`${provider}/${model}`)
    setErr('')
    try {
      const { rpc } = await import('../lib/gateway')
      const value = `${model} --provider ${provider} --session`
      await rpc('config.set', { key: 'model', value }, 20000)
      const { refreshModels } = await import('../lib/model')
      await refreshModels()
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Switch model</div>
        <div className="modal-body" style={{ paddingTop: 10 }}>
          <input className="input" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div style={{ maxHeight: 360, overflowY: 'auto', marginTop: 8 }}>
            {flat.slice(0, 60).map((r) => (
              <button key={`${r.provider}/${r.model}`} className="row" onClick={() => void pick(r.provider, r.model)} disabled={!!busy}>
                <span className="row-title">{r.model}</span>
                <span className="row-sub">{r.providerName ?? r.provider}{r.authenticated === false ? ' · needs key' : ''}</span>
                {busy === `${r.provider}/${r.model}` ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
              </button>
            ))}
            {flat.length === 0 ? <div style={{ padding: 14, color: 'var(--text-faint)', fontSize: 13 }}>No models — connect a provider in Connectors.</div> : null}
          </div>
          {err ? <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err}</div> : null}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function findLastIdxLocal<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i
  return -1
}

function turnText(msgs: ChatMessage[], assistantIdx: number): string {
  const parts: string[] = []
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      parts.unshift(msgs[i].segments.map((sg) => sg.text).join(''))
      break
    }
    parts.unshift(msgs[i].segments.filter((sg) => sg.kind === 'text').map((sg) => sg.text).join(''))
  }
  parts.push(msgs[assistantIdx].segments.filter((sg) => sg.kind === 'text').map((sg) => sg.text).join(''))
  return parts.filter(Boolean).join('\n\n')
}
