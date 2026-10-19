import { useStore } from '@nanostores/react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Brain, ChevronRight, CircleStop, ListTodo,
  Mic, Paperclip, Sparkles, Check, Cpu,
  SquareTerminal,
} from 'lucide-react'
import {
  activeSession, agentBusy, interrupt, liveRunOrigin, messages, newChat,
  openHomeThread, pendingRequest, patchSession, send, steer,
  tools as toolsAtom, todos as todosAtom, view,
  phaseForTools,
  type ChatMessage, type ChatSegment, type PendingCard, type ToolItem,
} from '../lib/chat'
import { accentFor, activeBotName, fleetProfiles } from '../lib/fleet'
import { isConnected, rpc } from '../lib/gateway'
import { renderMarkdown } from '../lib/markdown'
import { commandCatalog, completeSlash, dispatchSlash, refreshCommandCatalog } from '../lib/slash'
import { currentModel, providers, refreshModels } from '../lib/model'
import { startRecording, stopRecording } from '../lib/voice'
import { attachFiles } from '../lib/media'
import { locale, tr } from '../lib/strings'
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

// ── runs ─────────────────────────────────────────────────────────────────────

/**
 * One run: the exchange that follows a user message (the transcript head
 * stands in for intro/routine runs that carry no user row). Derived, never
 * stored — messages stay the single order of record and tools are assigned
 * to a run by timestamp, so the disclosure count is exact per run.
 */
interface RunView {
  key: string
  /** message index of the run's user message; -1 = head run */
  anchor: number
  /** the run's own (non-user) messages, in message order */
  msgs: ChatMessage[]
  tools: ToolItem[]
  live: boolean
}

function useRuns(msgs: ChatMessage[], toolsList: ToolItem[], busy: boolean): RunView[] {
  return useMemo(() => {
    const anchors: number[] = []
    for (let i = 0; i < msgs.length; i++) if (msgs[i].role === 'user') anchors.push(i)
    const bounds = [-1, ...anchors]
    const runs: RunView[] = []
    for (let b = 0; b < bounds.length; b++) {
      const anchor = bounds[b]
      const from = anchor + 1
      const to = b + 1 < bounds.length ? bounds[b + 1] : msgs.length
      const own = msgs.slice(from, to)
      const t0 = anchor >= 0 ? msgs[anchor].createdAt : (own[0]?.createdAt ?? 0)
      const t1 = b + 1 < bounds.length ? msgs[bounds[b + 1]].createdAt : Number.POSITIVE_INFINITY
      const runTools = toolsList.filter((t) =>
        t.startedAt === undefined ? b === bounds.length - 1 : t.startedAt >= t0 && t.startedAt < t1)
      if (anchor === -1 && own.length === 0 && runTools.length === 0) continue
      runs.push({ key: anchor >= 0 ? msgs[anchor].id : 'head', anchor, msgs: own, tools: runTools, live: false })
    }
    const last = runs.length - 1
    if (last >= 0 && busy) runs[last] = { ...runs[last], live: true }
    return runs
  }, [msgs, toolsList, busy])
}

// ── transcript ───────────────────────────────────────────────────────────────

function Transcript() {
  const msgs = useStore(messages)
  const toolsList = useStore(toolsAtom)
  const todosList = useStore(todosAtom)
  const card = useStore(pendingRequest)
  const busy = useStore(agentBusy)
  const session = useStore(view)
  const sid = useStore(activeSession)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  // An ask anchors where it landed in the flow: the card renders inside the
  // run that holds that position, and a message sent after it (a queued
  // send) appends below the card instead of pushing it down. The anchor is
  // captured once per card id, during render, from the transcript length
  // at arrival.
  const cardAnchor = useRef<{ id: string; at: number } | null>(null)
  if (!card) cardAnchor.current = null
  else if (cardAnchor.current?.id !== card.id) cardAnchor.current = { id: card.id, at: msgs.length - 1 }
  const cardAt = card && cardAnchor.current?.id === card.id
    ? Math.min(cardAnchor.current.at, msgs.length - 1)
    : -1

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
  }

  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [msgs, toolsList, todosList, card])

  const runs = useRuns(msgs, toolsList, busy)
  // The owner of the open thread. The session's own profile is the
  // race-free source (patched before the session activates, so a fresh
  // home thread never borrows the previous bot's name); the active bot is
  // the fallback while no thread is open yet.
  const botFallback = useStore(activeBotName)
  const ownerName = session?.profile ?? botFallback
  const lastMsg = msgs[msgs.length - 1]
  const footId = lastMsg && lastMsg.role === 'assistant' && !lastMsg.streaming ? lastMsg.id : null

  return (
    <div className="transcript" ref={scroller} onScroll={onScroll}>
      {msgs.length === 0 && !busy && !card ? <EmptyChat name={ownerName} /> : null}
      {msgs.length > 0 && !busy && sid ? <ClearConversation sid={sid} /> : null}
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

      {runs.map((run) => (
        <RunBlock
          key={run.key}
          run={run}
          msgs={msgs}
          name={ownerName}
          footId={footId}
          card={card}
          cardAfter={card && cardAt >= 0 && runHolds(run, cardAt) ? cardAt : null}
        />
      ))}

      {/* No anchor to hold (empty transcript): the card stands alone. Every
          anchored position renders inside its run above. */}
      {card && cardAt < 0 ? <InteractiveCard card={card} /> : null}
    </div>
  )
}

/** Whether message idx renders inside this run — its anchor row or one of
 *  its own — so an ask anchored after that message stays in its run. */
function runHolds(run: RunView, idx: number): boolean {
  return idx >= run.anchor && idx <= run.anchor + run.msgs.length
}

function RunBlock({ run, msgs, name, footId, card, cardAfter }: {
  run: RunView
  msgs: ChatMessage[]
  name: string | null
  footId: string | null
  card: PendingCard | null
  /** message index the ask card anchors after, when it is this run's */
  cardAfter: number | null
}) {
  const editTools = run.tools.filter((t) => t.editPath && (t.add || t.del))
  const headerTime = run.anchor >= 0
    ? msgs[run.anchor].createdAt
    : run.tools.find((t) => t.startedAt)?.startedAt
  return (
    <div className="run">
      {run.anchor >= 0 ? <MessageRow msg={msgs[run.anchor]} /> : null}
      {run.live ? (
        <TurnHeader name={name ?? tr('rail.mochi')} phase={phaseForTools(run.tools)} time={headerTime} />
      ) : null}
      {run.tools.length ? <ToolDisclosure tools={run.tools} live={run.live} /> : null}
      {editTools.map((t) => (
        <DiffBlock key={`d-${t.id}`} path={t.editPath!} add={t.add ?? 0} del={t.del ?? 0} src={t.output ?? ''} />
      ))}
      {cardAfter === run.anchor && card ? <InteractiveCard card={card} /> : null}
      {run.msgs.map((m, j) => (
        <Fragment key={m.id}>
          <MessageRow msg={m} />
          {m.role === 'assistant' && !m.streaming && m.id === footId ? (
            <MsgFoot idx={run.anchor + 1 + j} />
          ) : null}
          {cardAfter === run.anchor + 1 + j && card ? <InteractiveCard card={card} /> : null}
        </Fragment>
      ))}
    </div>
  )
}

const PHASE_KEYS: Record<string, string> = {
  Thinking: 'chat.phase.thinking',
  Editing: 'chat.phase.editing',
  'Running commands': 'chat.phase.running',
  Browsing: 'chat.phase.browsing',
  Researching: 'chat.phase.researching',
  'Loading skills': 'chat.phase.skills',
  Recovering: 'chat.phase.recovering',
  Working: 'chat.phase.working',
}

function TurnHeader({ name, phase, time }: { name: string; phase: string; time?: number }) {
  const loc = useStore(locale)
  const key = PHASE_KEYS[phase] ?? 'chat.phase.working'
  return (
    <div className="turnhead">
      <span className="tav">{name.slice(0, 2)}</span>
      <b>{name}</b>
      <span className="phase"><span className="plamp" /> {tr(key)}</span>
      {time ? <span className="ttime">{new Date(time).toLocaleTimeString(loc === 'ar' ? 'ar' : undefined, { hour: '2-digit', minute: '2-digit' })}</span> : null}
    </div>
  )
}

// ── tool-activity disclosure ─────────────────────────────────────────────────

/** While a run is live an expanded card lists only the last six steps. */
const LIVE_STEP_WINDOW = 6

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10000) {
    const s = Math.round(ms / 100) / 10
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`
  }
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  const t = Math.round(ms / 1000)
  return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`
}

/**
 * The run's one tool-activity line: closed by default, count while live,
 * count and duration folded in when the run finishes. Expanding lists the
 * steps (last six, with a count of earlier, while live).
 */
function ToolDisclosure({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  useStore(locale)
  const first = tools.find((t) => t.startedAt)?.startedAt
  const lastEnd = tools.reduce((n, t) => Math.max(n, t.endedAt ?? 0), 0)
  const dur = !live && first && lastEnd ? fmtDur(lastEnd - first) : ''
  const hidden = live && tools.length > LIVE_STEP_WINDOW ? tools.length - LIVE_STEP_WINDOW : 0
  const shown = hidden ? tools.slice(-LIVE_STEP_WINDOW) : tools
  return (
    <details className="rk-disc" data-live={live || undefined}>
      <summary>
        <ChevronRight size={13} className="rk-chev" />
        {live
          ? tr('chat.tools.working', { n: tools.length })
          : dur
            ? tr('chat.tools.done', { n: tools.length, d: dur })
            : tr('chat.tools.count', { n: tools.length })}
      </summary>
      <div className="rk-disc-body">
        {hidden > 0 ? <span className="rk-earlier">{tr('chat.tools.earlier', { n: hidden })}</span> : null}
        {shown.map((t) => (
          <div key={t.id} className="rk-step">
            <span className="gl">
              {t.status === 'running'
                ? <span className="spinner" style={{ width: 9, height: 9 }} />
                : t.status === 'error'
                  ? <span style={{ color: 'var(--red)' }}>✗</span>
                  : <Check size={12} color="var(--green)" />}
            </span>
            <b>{phaseVerb(t.name)}</b>
            <span className="arg">{argsShort(t)}</span>
            {t.endedAt && t.startedAt ? <span className="dur">{((t.endedAt - t.startedAt) / 1000).toFixed(1)}s</span> : null}
          </div>
        ))}
      </div>
    </details>
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

// ── thinking blocks ──────────────────────────────────────────────────────────

function ThinkBlock({ seg, streaming }: { seg: ChatSegment; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  useStore(locale)
  useEffect(() => {
    if (!streaming) return
    const t = setInterval(() => setElapsed(Math.round((Date.now() - (seg.startedAt ?? Date.now())) / 1000)), 1000)
    return () => clearInterval(t)
  }, [streaming, seg.startedAt])

  const kind = seg.kind === 'thinking' ? tr('chat.think.thinking') : tr('chat.think.reasoning')
  return (
    <div className="think">
      <div className="think-head" onClick={() => setOpen(v => !v)}>
        <Brain size={13} />
        <span>{kind}{streaming ? '' : ` · ${tr('chat.think.chars', { n: seg.text.length })}`}</span>
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

// ── messages ─────────────────────────────────────────────────────────────────

/** A message body: reasoning disclosures in flow order, consecutive text
 *  segments merged into one bubble — the active run streams as a single
 *  growing bubble (plain while streaming, markdown once complete). */
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
  const streaming = !!msg.streaming
  const groups: { text: boolean; segs: ChatSegment[] }[] = []
  for (const s of msg.segments) {
    const lastG = groups[groups.length - 1]
    if (s.kind === 'text' && lastG?.text) lastG.segs.push(s)
    else groups.push({ text: s.kind === 'text', segs: [s] })
  }
  return (
    <div className="msg assistant">
      {groups.map((g, i) => {
        if (!g.text) {
          const isTrailing = i === groups.length - 1
          return <ThinkBlock key={i} seg={g.segs[0]} streaming={streaming && isTrailing} />
        }
        const body = g.segs.map((s) => s.text).join('')
        const growing = streaming && i === groups.length - 1
        return growing ? (
          <div key={i} className="msg-assistant-body md streaming">{body}</div>
        ) : (
          <div key={i} className="msg-assistant-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
        )
      })}
    </div>
  )
}

function MsgFoot({ idx }: { idx: number }) {
  useStore(locale)
  return (
    <div className="msgfoot">
      <span onClick={() => void navigator.clipboard.writeText(turnTextByIdx(idx))}>⧉ copy</span>
      <span onClick={() => void speak(turnTextByIdx(idx))}>♪ listen</span>
      <span onClick={teachSkill}>✎ save as skill</span>
      <span onClick={() => {
        const msgs = messages.get()
        const lastU = findLastIdxLocal(msgs, (x: ChatMessage) => x.role === 'user')
        if (lastU >= 0) void send(msgs[lastU].segments.map((sg) => sg.text).join(''))
      }}>↻ retry</span>
    </div>
  )
}

/** Copy text for the reply at idx: the turn's user message plus replies. */
function turnTextByIdx(assistantIdx: number): string {
  const msgs = messages.get()
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

// ── inline diff card (a run's file edits) ────────────────────────────────────

function DiffBlock({ path, add, del, src }: { path: string; add: number; del: number; src: string }) {
  const [open, setOpen] = useState(false)
  useStore(locale)
  const lines = src ? src.split('\n').slice(0, 24) : []
  return (
    <div className="diffcard">
      <div className="diffhead">
        <span className="mono">{path.split('/').pop()}</span>
        <span className="dnum"><span className="add">+{add}</span> <span className="del">−{del}</span></span>
        <span className="viewdiff" onClick={() => setOpen(v => !v)}>{tr('chat.diff.view')} <ChevronRight size={10} style={{ transform: open ? 'rotate(90deg)' : 'none' }} /></span>
      </div>
      {open ? (
        <div className="diffln">
          {lines.map((l, i) => (
            <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx'}>{l}</span>
          ))}
          {lines.length === 0 ? <span className="ctx">{tr('chat.diff.unavailable')}</span> : null}
        </div>
      ) : null}
      <div className="difffoot">
        <span className="mono" style={{ fontSize: 10.5 }}>{path}</span>
        <span style={{ flex: 1 }} />
        <span className="dact" onClick={() => navigator.clipboard.writeText(src)}>{tr('chat.diff.copy')}</span>
      </div>
    </div>
  )
}

// ── empty state ──────────────────────────────────────────────────────────────

function EmptyChat({ name }: { name: string | null }) {
  useStore(locale)
  return (
    <div className="empty" style={{ padding: '60px 20px' }}>
      <Mochi mood="greeting" size={88} />
      <div className="empty-title">{name ? tr('chat.empty.title.bot', { name }) : tr('chat.empty.title')}</div>
      <div className="empty-sub">{tr('chat.empty.sub')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
        {[
          tr('chat.empty.chip.capabilities'),
          tr('chat.empty.chip.browser'),
          tr('chat.empty.chip.automation'),
          tr('chat.empty.chip.workspace'),
        ].map(s => (
          <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>
        ))}
      </div>
    </div>
  )
}

// ── clear conversation ───────────────────────────────────────────────────────

/**
 * Clear = rewind the home thread to empty, turn-free: each session.undo
 * removes one exchange durably and the gateway confirms the count, so local
 * transcript state is dropped only after the drain ends. The thread, its
 * binding and its title stay — a fresh start with the same bot.
 */
async function clearThread(sid: string): Promise<boolean> {
  try {
    for (let i = 0; i < 500; i++) {
      const r = await rpc<{ removed?: number }>('session.undo', { session_id: sid })
      if (!r?.removed) return true
    }
    return false
  } catch {
    return false
  }
}

function ClearConversation({ sid }: { sid: string }) {
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  useStore(locale)
  const go = async () => {
    setWorking(true)
    const ok = await clearThread(sid)
    setWorking(false)
    if (ok) {
      patchSession(sid, { messages: [], tools: [], todos: [] })
      setConfirming(false)
      setFailed(false)
    } else {
      setFailed(true)
    }
  }
  return (
    <div className="clearbar">
      {confirming ? (
        <div className="clear-confirm" role="alertdialog" aria-label={tr('chat.clear.confirm.title')}>
          <span>{tr('chat.clear.confirm.title')} <span className="clear-sub">{tr('chat.clear.confirm.body')}</span></span>
          <span style={{ flex: 1 }} />
          <button className="btn sm danger" disabled={working} onClick={() => void go()}>{tr('chat.clear.go')}</button>
          <button className="btn sm ghost" disabled={working} onClick={() => { setConfirming(false); setFailed(false) }}>{tr('chat.clear.keep')}</button>
        </div>
      ) : (
        <button className="clear-btn" onClick={() => setConfirming(true)}>{tr('chat.clear')}</button>
      )}
      {failed ? <span className="clear-fail">{tr('chat.clear.fail')}</span> : null}
    </div>
  )
}

// ── composer ─────────────────────────────────────────────────────────────────

/** What a send into the open thread will do right now. Derived, never stored:
 *  the gateway's rule decides it (a run this client started absorbs sends as
 *  steering, any other live run holds them), so the chip can only name the
 *  state, never choose it. A pending ask pauses the run — sends are held. */
type Posture = 'idle' | 'steer' | 'held'

/** One roster row for the @bot picker; key '' is the default agent (Mochi). */
interface AtBot { key: string; name: string | null; description: string }

/** The @token being typed at the caret, or null when the caret sits outside one. */
function atToken(value: string, caret: number): string | null {
  const m = value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)
  return m ? m[1] : null
}

function Composer() {
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [slashSel, setSlashSel] = useState(0)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [atOpen, setAtOpen] = useState(false)
  const [atQuery, setAtQuery] = useState('')
  const [atSel, setAtSel] = useState(0)
  /** The @ override: undefined sends to the open thread, a roster key sends to
   *  that bot's home thread (the session there carries the profile). */
  const [atKey, setAtKey] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)
  const busy = useStore(agentBusy)
  const origin = useStore(liveRunOrigin)
  const card = useStore(pendingRequest)
  const session = useStore(view)
  const sid = useStore(activeSession)
  const botName = useStore(activeBotName)
  const profiles = useStore(fleetProfiles)
  const catalog = useStore(commandCatalog)
  const model = useStore(currentModel)
  const provs = useStore(providers)
  const lang = useStore(locale) // order 15: every tr() here re-renders on a locale switch
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const posture: Posture = card ? 'held' : origin === 'chat' ? 'steer' : origin ? 'held' : 'idle'
  const ownerKey = session?.profile ?? ''

  const completions = useMemo(() => completeSlash(text, catalog), [text, catalog])

  const roster = useMemo<AtBot[]>(() => [
    { key: '', name: null, description: tr('rail.mochi.job') },
    ...profiles.filter((b) => b.name !== 'default').map((b) => ({
      key: b.name,
      name: b.name,
      description: b.description || tr('rail.nodesc'),
    })),
  ], [profiles, lang])

  const atMatches = useMemo(() => {
    if (!atOpen) return []
    const needle = atQuery.trim().toLowerCase()
    if (!needle) return roster
    return roster.filter((r) =>
      `${r.name ?? tr('rail.mochi')}\n${r.description}`.toLowerCase().includes(needle))
  }, [atOpen, atQuery, roster, lang])

  const atName = (key: string): string =>
    key === '' ? tr('rail.mochi') : (roster.find((r) => r.key === key)?.name ?? key)

  /** Picker follows the caret: any @token opens it, leaving the token closes it. */
  const syncAt = (value: string, caret: number) => {
    const q = atToken(value, caret)
    setAtOpen(q !== null)
    setAtQuery(q ?? '')
    setAtSel(0)
  }

  // The address names a redirect away from the open thread; navigating away
  // cancels it so a later send can never land somewhere silently.
  useEffect(() => { setAtKey(undefined); setAtOpen(false) }, [sid])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [text])

  useEffect(() => setSlashSel(0), [text])

  const pickAt = (b: AtBot) => {
    const ta = taRef.current
    const caret = ta?.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const after = text.slice(caret)
    const m = before.match(/(?:^|\s)@([^\s@]*)$/)
    const kept = m ? before.slice(0, before.length - m[0].length) : before
    setText(kept + after.replace(/^ /, ''))
    setAtKey(b.key)
    setAtOpen(false)
    taRef.current?.focus()
  }

  const submit = async () => {
    const t = text.trim()
    if ((!t && pendingFiles.length === 0) || sending) return
    setSending(true)
    setNotice(null)
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
      if (atKey !== undefined && atKey !== ownerKey) {
        // Addressing rides the profile tagging that already exists: the send
        // lands in that bot's home thread, whose session carries the profile.
        try {
          const target = await openHomeThread(atKey === '' ? null : atKey)
          if (!target) throw new Error('home thread did not open')
        } catch {
          setNotice(tr('chat.composer.at.fail', { name: atName(atKey) }))
          return
        }
      }
      setAtKey(undefined)
      if (pendingFiles.length) {
        const fsid = activeSession.get() ?? (await newChat().catch(() => null))
        if (!fsid) return
        const ok = await attachFiles(fsid, pendingFiles).catch(() => false)
        setPendingFiles([])
        if (!ok) return
      }
      setText('')
      // Derived again after any thread switch: the posture names the thread
      // the send actually lands in.
      if (!pendingRequest.get() && liveRunOrigin.get() === 'chat') {
        try {
          await steer(t)
        } catch {
          setText(t)
          setNotice(tr('chat.composer.steer.fail'))
        }
      } else {
        void send(t)
      }
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
      {atOpen ? (
        <div className="slash-pop at-pop">
          {atMatches.length ? atMatches.map((b, i) => (
            <div
              key={b.key}
              className={`row${i === atSel ? ' active' : ''}`}
              onMouseEnter={() => setAtSel(i)}
              onClick={() => pickAt(b)}
            >
              <span className="at-dot" style={{ background: b.key === '' ? 'var(--text-faint)' : accentFor(b.key) }} />
              <span className="row-title" style={{ fontSize: 12.5 }}>{b.name ?? tr('rail.mochi')}</span>
              <span className="row-sub">{b.description}</span>
            </div>
          )) : <div className="row"><span className="row-sub">{tr('chat.at.empty')}</span></div>}
        </div>
      ) : null}
      {atKey !== undefined && atKey !== ownerKey ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap', maxWidth: 860 }}>
          <span className="chip" title={tr('chat.composer.at')}>
            {tr('chat.at.label')}: <b>{atName(atKey)}</b>
            <button aria-label={tr('chat.at.clear')} onClick={() => setAtKey(undefined)} style={{ marginLeft: 2, color: 'var(--text-faint)' }}>×</button>
          </span>
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
      {notice ? <div style={{ color: 'var(--red)', fontSize: 11, marginBottom: 4, maxWidth: 860 }}>{notice}</div> : null}
      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          placeholder={
            posture === 'steer' ? tr('chat.composer.placeholder.steer')
              : posture === 'held' ? tr('chat.composer.placeholder.held')
                : botName ? tr('chat.composer.placeholder.bot', { name: botName })
                  : tr('chat.composer.placeholder')
          }
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            syncAt(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onSelect={(e) => {
            const ta = e.currentTarget
            syncAt(ta.value, ta.selectionStart ?? ta.value.length)
          }}
          onKeyDown={(e) => {
            if (atOpen) {
              if (e.key === 'Escape') {
                e.preventDefault()
                setAtOpen(false)
                return
              }
              if (['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(e.key)) {
                if (atMatches.length === 0) {
                  if (e.key !== 'Enter') { e.preventDefault(); return }
                  setAtOpen(false) // nothing to pick — let Enter fall through to send
                } else {
                  e.preventDefault()
                  if (e.key === 'ArrowDown') setAtSel(s => Math.min(s + 1, atMatches.length - 1))
                  else if (e.key === 'ArrowUp') setAtSel(s => Math.max(s - 1, 0))
                  else pickAt(atMatches[Math.min(atSel, atMatches.length - 1)])
                  return
                }
              }
            }
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
          {posture !== 'idle' ? (
            <span
              className={`posture-chip${posture === 'steer' ? ' steer' : ' held'}`}
              title={card ? tr('chat.steer.title.paused') : posture === 'steer' ? tr('chat.steer.title.steering') : tr('chat.steer.title.waiting')}
            >
              <span className="dot" />
              {posture === 'steer' ? tr('chat.steer.chip.steering') : tr('chat.steer.chip.waiting')}
            </span>
          ) : null}
          <button className="composer-chip" onClick={() => setModelPickerOpen(true)} title={tr('chat.composer.model')}>
            <Cpu size={12} /> {model.model ?? tr('chat.composer.model')} <span style={{ opacity: .6 }}>⌄</span>
          </button>
          <button className="composer-chip" title={tr('chat.composer.at')} onClick={() => { setAtOpen(true); setAtQuery(''); setAtSel(0); taRef.current?.focus() }}>
            @ {atKey !== undefined && atKey !== ownerKey ? atName(atKey) : (botName ?? tr('rail.mochi'))}
          </button>
          <button className="composer-chip" title={tr('chat.composer.tools.title')} onClick={() => { setText('/'); taRef.current?.focus() }}>{tr('chat.composer.tools.label')}</button>
          <button className="composer-chip" title={tr('chat.composer.code.title')} onClick={() => window.dispatchEvent(new CustomEvent('moch-workbench', { detail: 'terminal' }))}>
            <SquareTerminal size={12} /> {tr('chat.composer.code.label')}
          </button>
          {busy ? (
            <button className="composer-chip" onClick={() => void interrupt()} title={tr('chat.composer.stop.title')}>
              <CircleStop size={12} /> {tr('chat.composer.stop.label')}
            </button>
          ) : null}
          <div style={{ flex: 1 }} />
          <button
            className={`composer-chip${recording ? ' accent' : ''}`}
            onClick={onVoice}
            title={recording ? tr('chat.composer.voice.stop') : tr('chat.composer.voice.go')}
          >
            {recording
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="status-dot warn" style={{ margin: 0, transform: `scale(${1 + level * 1.2})`, transition: 'transform 80ms' }} /> {Math.round(level * 100)}%</span>
              : <Mic size={12} />}
          </button>
          <button className="composer-send" onClick={() => void submit()} disabled={(!text.trim() && pendingFiles.length === 0) || sending} aria-label={tr('chat.composer.send')}>
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
  useStore(locale)
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
        <div className="modal-head">{tr('chat.model.title')}</div>
        <div className="modal-body" style={{ paddingTop: 10 }}>
          <input className="input" placeholder={tr('chat.model.search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div style={{ maxHeight: 360, overflowY: 'auto', marginTop: 8 }}>
            {flat.slice(0, 60).map((r) => (
              <button key={`${r.provider}/${r.model}`} className="row" onClick={() => void pick(r.provider, r.model)} disabled={!!busy}>
                <span className="row-title">{r.model}</span>
                <span className="row-sub">{r.providerName ?? r.provider}{r.authenticated === false ? ` · ${tr('chat.model.needskey')}` : ''}</span>
                {busy === `${r.provider}/${r.model}` ? <span className="spinner" style={{ width: 11, height: 11 }} /> : null}
              </button>
            ))}
            {flat.length === 0 ? <div style={{ padding: 14, color: 'var(--text-faint)', fontSize: 13 }}>{tr('chat.model.none')}</div> : null}
          </div>
          {err ? <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{err}</div> : null}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{tr('chat.model.close')}</button>
        </div>
      </div>
    </div>
  )
}

function findLastIdxLocal<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i
  return -1
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
