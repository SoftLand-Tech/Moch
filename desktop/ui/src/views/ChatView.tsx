import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Brain, ChevronRight, CircleStop, Copy, GitBranch, ListTodo, LockKeyhole,
  MessageSquarePlus, Mic, Paperclip, Pin, PinOff, Search, Sparkles, Trash2, Wrench,
  Check, Volume2, Cpu,
} from 'lucide-react'
import {
  activeSession, activeTitle, agentBusy, answerCard, deleteSession,
  interrupt, messages, newChat, pendingRequest, renameSession, send, sessionMarks,
  sessionOrder, sessionsById, steer, switchToSession, toggleMark,
  tools as toolsAtom, todos as todosAtom,
  type ChatMessage, type ChatSegment, type PendingCard, type ToolItem,
} from '../lib/chat'
import { accentFor, activeBotAtom, activeBotName, fleetProfiles, setActiveBot } from '../lib/fleet'
import { isConnected } from '../lib/gateway'
import { renderMarkdown } from '../lib/markdown'
import { commandCatalog, completeSlash, dispatchSlash, refreshCommandCatalog } from '../lib/slash'
import { currentModel, providers, refreshModels } from '../lib/model'
import { startRecording, stopRecording } from '../lib/voice'
import { attachFiles } from '../lib/media'
import InteractiveCard from '../components/InteractiveCard'

export default function ChatView() {
  const order = useStore(sessionOrder)
  const marks = useStore(sessionMarks)
  const active = useStore(activeSession)
  const byId = useStore(sessionsById)
  const title = useStore(activeTitle)
  const busy = useStore(agentBusy)
  const bot = useStore(activeBotAtom)
  const connected = useStore(isConnected)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (connected) {
      void refreshCommandCatalog()
      void refreshModels()
    }
  }, [connected])

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = order.filter((r) => !q || r.title.toLowerCase().includes(q))
    const pinned = rows.filter((r) => marks.pinned.includes(r.id))
    const rest = rows.filter((r) => !marks.pinned.includes(r.id) && !marks.archived.includes(r.id))
    const archived = rows.filter((r) => marks.archived.includes(r.id))
    return [
      pinned.length ? { label: 'Pinned', rows: pinned } : null,
      { label: 'All chats', rows: rest },
      archived.length ? { label: 'Archived', rows: archived } : null,
    ].filter(Boolean) as { label: string; rows: typeof order }[]
  }, [order, search, marks])

  const activeStored = active ? byId[active]?.storedId : undefined
  const activeRow = activeStored ? order.find((r) => r.id === activeStored) : undefined

  return (
    <>
      <aside className="ctx">
        <div className="ctx-head">
          <span className="ctx-title">Chats</span>
          <div className="ctx-actions">
            <button className="btn ghost sm" title="New chat (a fresh session)" onClick={() => void newChat()} disabled={!connected}>
              <MessageSquarePlus size={15} />
            </button>
          </div>
        </div>
        <div className="ctx-search">
          <Search size={13} />
          <input placeholder="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {bot ? (
          <div style={{ margin: '0 12px 8px', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 10, background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
            <span className="avatar" style={{ width: 22, height: 22, fontSize: 10, background: accentFor(bot) }}>{bot.slice(0, 2)}</span>
            <span style={{ fontSize: 12.5, color: 'var(--accent)', fontWeight: 600 }}>New chats go to {bot}</span>
            <button
              className="chip"
              style={{ marginLeft: 'auto', padding: '2px 8px' }}
              title="Switch back to the default agent"
              onClick={() => void setActiveBot(null)}
            >
              switch back
            </button>
          </div>
        ) : null}
        <div className="ctx-body">
          {grouped.map((g) => (
            <div key={g.label}>
              <div className="row-section">{g.label}</div>
              {g.rows.length === 0 && g.label === 'All chats' ? (
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-faint)' }}>
                  No chats yet — say hi below.
                </div>
              ) : g.rows.map((r) => {
                const liveId = active && byId[active]?.storedId === r.id ? active : undefined
                const isBotChat = r.profile && r.profile !== 'default'
                const rowBusy = isRowBusy(r.id, byId)
                return (
                  <div key={r.id} className={`row${liveId ? ' active' : ''}`} onClick={() => void switchToSession(r.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && void switchToSession(r.id)}>
                    {isBotChat ? (
                      <span className="avatar" style={{ width: 20, height: 20, fontSize: 9, background: accentFor(r.profile ?? '') }}>{(r.profile ?? 'b').slice(0, 2)}</span>
                    ) : null}
                    <span className="row-title" style={{ color: isBotChat ? accentFor(r.profile ?? '') : undefined }}>{r.title}</span>
                    {rowBusy ? <span className="row-meta" style={{ color: 'var(--accent)' }}>●</span> : null}
                    <button
                      className="msg-action"
                      title={marks.pinned.includes(r.id) ? 'Unpin' : 'Pin'}
                      onClick={(e) => { e.stopPropagation(); toggleMark('pinned', r.id) }}
                    >
                      {marks.pinned.includes(r.id) ? <PinOff size={12} /> : <Pin size={12} />}
                    </button>
                    <button
                      className="msg-action"
                      title={marks.archived.includes(r.id) ? 'Unarchive' : 'Archive'}
                      onClick={(e) => { e.stopPropagation(); toggleMark('archived', r.id) }}
                    >
                      <ChevronRight size={12} style={{ transform: marks.archived.includes(r.id) ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
                    </button>
                    <button
                      className="msg-action"
                      title="Delete chat"
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${r.title}"?`)) void deleteSession(r.id) }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </aside>

      <main className="focus">
        <div className="focus-head">
          {activeRow?.profile && activeRow.profile !== 'default' ? (
            <span className="avatar" style={{ width: 24, height: 24, fontSize: 10, background: accentFor(activeRow.profile) }}>{activeRow.profile.slice(0, 2)}</span>
          ) : null}
          <span style={{ fontWeight: 650, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '46%' }}>{title}</span>
          {busy ? (
            <span className="chip" style={{ borderColor: 'transparent', color: 'var(--accent)', cursor: 'default' }}>
              <span className="spinner" style={{ width: 10, height: 10 }} /> working
            </span>
          ) : null}
          <div style={{ flex: 1 }} />
          {activeStored ? (
            <button className="btn ghost sm" title="Rename (server-side, sticks)" onClick={() => {
              const t = prompt('Rename chat', title)
              if (t && t.trim()) void renameSession(activeStored!, t.trim())
            }}>Rename</button>
          ) : null}
        </div>
        <Transcript />
        <Composer />
      </main>
    </>
  )
}

function isRowBusy(storedId: string, byId: Record<string, { busy: boolean; storedId?: string }>): boolean {
  for (const s of Object.values(byId)) {
    if (s.storedId === storedId && s.busy) return true
  }
  return false
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

  const visibleTools = useMemo(() => toolsList.slice(-14), [toolsList])

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
      {msgs.map((m) => <MessageRow key={m.id} msg={m} />)}
      {visibleTools.filter(t => t.status === 'running').map((t) => <ToolRow key={t.id} tool={t} />)}
      {card ? <InteractiveCard card={card} /> : null}
      {busy && !msgs.some(m => m.streaming) ? (
        <div className="busy-strip"><div className="spinner" style={{ width: 12, height: 12 }} /> thinking…</div>
      ) : null}
    </div>
  )
}

function EmptyChat() {
  const bot = useStore(activeBotAtom)
  const name = bot ?? null
  return (
    <div className="empty" style={{ padding: '60px 20px' }}>
      <span className="avatar" style={{ width: 54, height: 54, fontSize: 22, borderRadius: 16, background: name ? accentFor(name) : 'var(--accent)' }}>
        {name ? name.slice(0, 2) : 'M'}
      </span>
      <div className="empty-title">{name ? `Talk to ${name}` : 'What should Mochi do?'}</div>
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
  const reasoning = msg.segments.filter((s) => s.kind === 'reasoning' || s.kind === 'thinking')
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
      {!streaming && text.length ? (
        <div className="msg-row-meta">
          <div className="msg-actions">
            <button className="msg-action" onClick={() => void navigator.clipboard.writeText(text.map(s => s.text).join(''))}><Copy size={11} /> copy</button>
            <button className="msg-action" onClick={() => void speak(text.map(s => s.text).join(''))}><Volume2 size={11} /> listen</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

async function speak(text: string): Promise<void> {
  try {
    const { gwFetch } = await import('../lib/gateway')
    const bytes = (await gwFetch('/api/audio/speak', {
      method: 'POST',
      body: JSON.stringify({ text }),
      contentType: 'application/json',
      binary: true,
    })) as Uint8Array
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/mpeg' })
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
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
        <Wrench size={13} color="var(--accent)" />
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
  const [dragOver, setDragOver] = useState(false)
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
        // Attachments need a live session — create one lazily like send().
        const sid = activeSession.get() ?? (await newChat().catch(() => null))
        if (!sid) return
        const ok = await attachFiles(sid, pendingFiles).catch(() => false)
        setPendingFiles([])
        if (!ok) return
      }
      setText('')
      if (steerMode) void steer(t)
      else void send(t) // send() lazily creates the session on first message
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

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length) setPendingFiles((prev) => [...prev, ...files].slice(0, 8))
  }

  return (
    <div
      className="composer-wrap"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: -6, borderRadius: 18 } : undefined}
    >
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
              <Sparkles size={13} color="var(--accent)" />
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
          placeholder={steerMode ? 'Steer the running turn — delivered at the next boundary…' : botName ? `Message ${botName}…` : 'Ask Mochi anything — / for commands'}
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
        <div className="composer-bar">
          {busy ? (
            <button className="composer-chip" onClick={() => void interrupt()} title="Stop the running turn">
              <CircleStop size={12} /> stop
            </button>
          ) : null}
          <button
            className={`composer-chip${steerMode ? ' accent' : ''}`}
            onClick={() => setSteerMode(v => !v)}
            title="Queue a steering message delivered at the next turn boundary"
          >
            <GitBranch size={12} /> steer
          </button>
          <button
            className="composer-chip"
            onClick={() => fileRef.current?.click()}
            title="Attach files or images"
          >
            <Paperclip size={12} />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              setPendingFiles(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button
            className={`composer-chip${recording ? ' accent' : ''}`}
            onClick={onVoice}
            title={recording ? 'Stop and transcribe' : 'Dictate — transcribed through your gateway'}
          >
            {recording
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="status-dot warn" style={{ margin: 0, transform: `scale(${1 + level * 1.2})`, transition: 'transform 80ms' }} /> {Math.round(level * 100)}%</span>
              : <Mic size={12} />}
          </button>
          {model.model ? (
            <button className="composer-chip" onClick={() => setModelPickerOpen(true)} title="Model — click to switch">
              <Cpu size={12} /> {model.model.length > 18 ? `${model.model.slice(0, 16)}…` : model.model}
            </button>
          ) : null}
          <div style={{ flex: 1 }} />
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
      // The gateway's own /model grammar — one code path with the CLI.
      const value = `${model} --provider ${provider} --session`
      await rpc('config.set', {
        key: 'model',
        value,
        session_id: activeSession.get() ?? undefined,
      }, 20000)
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
