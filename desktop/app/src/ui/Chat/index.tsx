/**
 * Moch Desktop — Chat surface. The dedicated desktop transcript + composer,
 * reading every piece of conversation state from the shared engine
 * (app/src/lib/chat.ts nanostores atoms) and acting only through its
 * functions. No protocol or business logic lives here.
 *
 * Layout: one scroller (the transcript, measure ≤760px centered), then the
 * run strip (tool log + todos), question cards, queue strip, and the
 * composer docked at the pane bottom in normal flow.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  activeSession,
  activeQueue,
  activeStoredId,
  agentBusy,
  chatBanner,
  hookChatEvents,
  messages,
  openLocalChatIfNeeded,
  retryMessage,
  sendPrompt,
  sessionLoadings,
  stopRun,
  todos,
  tools,
  type TodoItem,
} from '../../../../../app/src/lib/chat'
import { connectionState } from '../../../../../app/src/lib/gateway'
import { enqueueSend, removeQueued, type QueuedSend } from '../../../../../app/src/lib/sendQueue'
import { drafts, setDraft } from '../../../../../app/src/lib/drafts'
import { contentGrew, evaluateStick, shouldFollowOnAppend } from '../../../../../app/src/lib/chatScroll'
import { MessageRow, ToolRow } from './Message'
import { QuestionCards } from './Cards'
import './chat.css'

/** Tool log summary line: "bash ×2, read ×4" — the names are the content. */
function toolSummary(list: { name: string }[]): string {
  const counts: Record<string, number> = {}
  for (const t of list) counts[t.name] = (counts[t.name] ?? 0) + 1
  return Object.entries(counts)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ')
}

function TodoList({ td }: { td: TodoItem[] }) {
  return (
    <div className="moch-todos">
      {td.map((t, i) => (
        <div key={i} className={`moch-todos__item${t.done ? ' moch-todos__item--done' : ''}`}>
          <span className="moch-todos__mark" aria-hidden>
            {t.done ? '✓' : '○'}
          </span>
          {t.text}
        </div>
      ))}
    </div>
  )
}

function QueueStrip({
  queued,
  storedId,
  busy,
  conn,
  onEdit,
}: {
  queued: QueuedSend[]
  storedId: string | null
  busy: boolean
  conn: string
  onEdit: (q: QueuedSend) => void
}) {
  if (!storedId || queued.length === 0) return null
  return (
    <div className="moch-queue" aria-label="Queued messages">
      <div className="moch-queue__head">
        {queued.length === 1 ? '1 message' : `${queued.length} messages`} queued ·{' '}
        {busy ? 'sends when this reply finishes' : conn === 'open' ? 'sending…' : 'waiting for connection'}
      </div>
      {queued.slice(0, 3).map((q) => (
        <div key={q.id} className="moch-queue__row">
          <button
            type="button"
            className="moch-queue__text"
            onClick={() => onEdit(q)}
            aria-label={`Edit queued message: ${q.text.slice(0, 60)}`}
          >
            {q.text}
          </button>
          <button
            type="button"
            className="moch-queue__act"
            onClick={() => removeQueued(storedId, q.id)}
            aria-label="Remove queued message"
          >
            ✕
          </button>
        </div>
      ))}
      {queued.length > 3 ? <div className="moch-queue__more">+{queued.length - 3} more</div> : null}
    </div>
  )
}

export function Chat() {
  const msgs = useStore(messages)
  const tls = useStore(tools)
  const td = useStore(todos)
  const busy = useStore(agentBusy)
  const banner = useStore(chatBanner)
  const queued = useStore(activeQueue)
  const storedId = useStore(activeStoredId)
  const sid = useStore(activeSession)
  const loadings = useStore(sessionLoadings)
  const conn = useStore(connectionState)
  const draftsMap = useStore(drafts)

  // The composer's single source of truth is the shared drafts atom (keyed
  // by stored id): typing writes setDraft, and an external draft drop (e.g.
  // a Skills "Run") appears live without a chat switch.
  const input = storedId ? (draftsMap[storedId] ?? '') : ''

  // A chat whose content is still on its way must never read as a fresh
  // empty chat (phone parity).
  const booting = !!(storedId && loadings[storedId]) && msgs.length === 0

  const [toolsOpen, setToolsOpen] = useState(false)
  // The finished-turn tool log collapses on its own; turn edges and chat
  // switches re-collapse it.
  useEffect(() => {
    setToolsOpen(false)
  }, [storedId, busy])

  // Engine wiring: idempotent event intake + the local new-chat window, so
  // the surface is self-sufficient even before the shell owns these.
  useEffect(() => {
    hookChatEvents()
    openLocalChatIfNeeded()
  }, [sid])

  // ── Stick-to-bottom tracking (chatScroll policy, DOM coords mapped to
  // the policy's inverted list coordinates: y = distance from the bottom).
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const metrics = useRef({ y: 0, contentH: 0, viewH: 0 })
  const stickUntil = useRef(0)
  const stickRef = useRef(true)
  const busyRef = useRef(busy)
  const [stick, setStick] = useState(true)
  const [showJump, setShowJump] = useState(false)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const readScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    metrics.current = {
      y: el.scrollHeight - el.clientHeight - el.scrollTop,
      contentH: el.scrollHeight,
      viewH: el.clientHeight,
    }
    const verdict = evaluateStick(metrics.current)
    if (!verdict) return
    stickRef.current = verdict.stick
    setStick(verdict.stick)
    setShowJump(verdict.showJump)
  }, [])

  const scrollToBottom = useCallback((animated: boolean) => {
    const el = scrollRef.current
    if (!el) return
    if (animated) {
      stickUntil.current = Date.now() + 500
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  // A chat swap resets the reading position to the newest message.
  useEffect(() => {
    stickRef.current = true
    setStick(true)
    setShowJump(false)
    metrics.current = { y: 0, contentH: 0, viewH: 0 }
    scrollToBottom(false)
  }, [storedId, scrollToBottom])

  // Appends and streaming deltas follow the pinned reader.
  const lastMsgText = msgs[msgs.length - 1]?.text
  const lastMsgSegs = msgs[msgs.length - 1]?.segments?.length
  useEffect(() => {
    if (!shouldFollowOnAppend(metrics.current, { stick, quietWindow: Date.now() < stickUntil.current })) {
      return
    }
    const t = setTimeout(() => scrollToBottom(!busy), 16)
    return () => clearTimeout(t)
  }, [msgs.length, lastMsgText, lastMsgSegs, tls.length, stick, busy, scrollToBottom])

  // Content growth while pinned (thinking-only streams don't touch message
  // text) — same trigger as the phone's onContentSizeChange.
  useEffect(() => {
    const inner = contentRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current
      if (!el) return
      metrics.current.contentH = el.scrollHeight
      const action = contentGrew(metrics.current, stickRef.current)
      if (action === 'follow') scrollToBottom(!busyRef.current)
      else if (action === 'reevaluate') readScroll()
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [readScroll, scrollToBottom])

  const jumpToLatest = useCallback(() => {
    stickUntil.current = Date.now() + 800
    stickRef.current = true
    setStick(true)
    setShowJump(false)
    scrollToBottom(true)
  }, [scrollToBottom])

  const onRetryMsg = useCallback((id: string) => {
    void retryMessage(id).catch(() => {})
  }, [])

  const updateInput = useCallback(
    (t: string) => {
      setDraft(storedId, t)
    },
    [storedId],
  )

  // Textarea auto-grow, clamped (WebKit has no field-sizing).
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [input])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    if (busy) {
      // Mid-turn sends queue on the visible strip; maybeFlushQueue delivers
      // them at the turn edge (engine-owned).
      if (!storedId) return
      const item = enqueueSend(storedId, text)
      if (!item) return
      setDraft(storedId, '')
      return
    }
    setDraft(storedId, '')
    try {
      await sendPrompt(text)
    } catch {
      // The engine filed a failed row + outbox entry; give the text back.
      setDraft(storedId, text)
    }
  }, [input, busy, storedId])

  const editQueued = useCallback(
    (q: QueuedSend) => {
      if (!storedId) return
      removeQueued(storedId, q.id)
      setDraft(storedId, q.text)
    },
    [storedId],
  )

  const summary = toolSummary(tls)
  const composerPlaceholder = busy ? 'Reply — queued until it finishes' : 'Message Moch'

  return (
    <div className="moch-chat">
      {banner ? (
        <button type="button" className="moch-banner" onClick={() => banner.retry?.()}>
          {banner.text}
        </button>
      ) : null}

      <div className="moch-chat__scrollwrap">
        <div className="moch-chat__scroll" ref={scrollRef} onScroll={readScroll}>
          <div className="moch-col moch-chat__col" ref={contentRef}>
            {msgs.length === 0 ? (
              booting ? (
                <div className="moch-booting">Loading chat…</div>
              ) : (
                <div className="moch-empty">New conversation — type below to start</div>
              )
            ) : (
              msgs.map((m) => <MessageRow key={m.id} m={m} onRetry={onRetryMsg} />)
            )}
          </div>
        </div>
        {showJump ? (
          <button type="button" className="moch-jump" onClick={jumpToLatest} aria-label="Jump to latest">
            ↓ latest
          </button>
        ) : null}
      </div>

      <div className="moch-dock">
        <div className="moch-col">
          {tls.length > 0 || td.length > 0 ? (
            <div className="moch-run">
              {busy ? (
                <>
                  {tls.slice(-3).map((t) => (
                    <ToolRow key={t.id} t={t} />
                  ))}
                  {tls.length > 3 ? <div className="moch-run__more">+{tls.length - 3} more</div> : null}
                </>
              ) : tls.length > 0 && !toolsOpen ? (
                <button
                  type="button"
                  className="moch-run__toggle"
                  onClick={() => setToolsOpen(true)}
                  aria-label={`Show ${tls.length} tool calls: ${summary}`}
                >
                  <span className="moch-run__summary">{summary}</span>
                  <span className="moch-run__chev" aria-hidden>
                    ▸
                  </span>
                </button>
              ) : tls.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="moch-run__toggle"
                    onClick={() => setToolsOpen(false)}
                    aria-label="Hide tool calls"
                  >
                    <span className="moch-run__summary">{summary}</span>
                    <span className="moch-run__chev" aria-hidden>
                      ▾
                    </span>
                  </button>
                  <div className="moch-run__list">
                    {tls.map((t) => (
                      <ToolRow key={t.id} t={t} />
                    ))}
                  </div>
                </>
              ) : null}
              {td.length > 0 ? <TodoList td={td} /> : null}
            </div>
          ) : null}

          <QuestionCards />

          <QueueStrip queued={queued} storedId={storedId} busy={busy} conn={conn} onEdit={editQueued} />

          <div className="moch-composer">
            <textarea
              ref={inputRef}
              className="moch-composer__input"
              value={input}
              rows={1}
              onChange={(e) => updateInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={composerPlaceholder}
              aria-label="Message input"
            />
            {busy ? (
              <button
                type="button"
                className="moch-btn moch-btn--round moch-btn--stop"
                onClick={() => void stopRun()}
                aria-label="Stop"
              >
                ■
              </button>
            ) : null}
            <button
              type="button"
              className="moch-btn moch-btn--round"
              onClick={() => void send()}
              disabled={!input.trim()}
              aria-label={busy ? 'Queue message' : 'Send message'}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Chat
