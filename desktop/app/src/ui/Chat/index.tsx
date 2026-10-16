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
import { sessionRows } from '../../../../../app/src/lib/sessionList'
import { liveModel, liveProvider } from '../../../../../app/src/lib/modelState'
import { setShellLayout } from '../shell/state'
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

/**
 * The brand mascot (the greeting pose from desktop/ui/public/brand/
 * mochi-greeting.svg), inlined so the empty chat is unmistakably
 * intentional. Token-colored where a token exists — sprout, visor, blush
 * and body follow the theme; pure shading stops keep their brand values
 * as var fallbacks.
 */
function MochiMascot({ size = 104 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1254 1254" aria-hidden className="moch-empty__art">
      <defs>
        <linearGradient id="mg-sprout" x1="790" y1="380" x2="950" y2="265" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--moch-accent-dark, #E76437)" />
          <stop offset="55%" stopColor="var(--moch-accent, #F89236)" />
          <stop offset="100%" stopColor="var(--moch-blush, #FA9F3C)" />
        </linearGradient>
        <linearGradient id="mg-body" x1="627" y1="330" x2="627" y2="990" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--moch-user-bubble, #F8EFE5)" />
          <stop offset="68%" stopColor="var(--moch-user-bubble, #F6ECE1)" />
          <stop offset="78%" stopColor="#ECE0D2" />
          <stop offset="88%" stopColor="#DECFC0" />
          <stop offset="96%" stopColor="#C7B3A1" />
          <stop offset="100%" stopColor="#BCA594" />
        </linearGradient>
        <linearGradient id="mg-visor" x1="627" y1="420" x2="627" y2="812" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--moch-user-text, #2B283B)" />
          <stop offset="100%" stopColor="var(--moch-bg-card, #211F2D)" />
        </linearGradient>
        <linearGradient id="mg-hand" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFDFB" />
          <stop offset="50%" stopColor="#FAF1E7" />
          <stop offset="100%" stopColor="#D5C1AF" />
        </linearGradient>
      </defs>
      <path
        d="M 780 375 C 820 410, 835 365, 890 350 C 945 350, 972 310, 960 286 C 958 264, 940 260, 910 255 C 872 255, 832 275, 806 310 C 770 348, 772 370, 780 375 Z"
        fill="url(#mg-sprout)"
      />
      <path
        d="M 627 335 C 730 335, 835 375, 905 440 C 960 495, 974 570, 974 645 C 974 770, 930 870, 835 940 C 775 985, 700 985, 627 985 C 554 985, 479 985, 419 940 C 324 870, 280 770, 280 645 C 280 570, 294 495, 349 440 C 419 375, 524 335, 627 335 Z"
        fill="url(#mg-body)"
      />
      <path
        d="M 627 420 C 725 420, 815 440, 858 480 C 892 515, 897 565, 897 615 C 897 670, 890 720, 855 758 C 812 795, 725 812, 627 812 C 529 812, 442 795, 399 758 C 364 720, 357 670, 357 615 C 357 565, 362 515, 396 480 C 439 440, 529 420, 627 420 Z"
        fill="url(#mg-visor)"
      />
      <g fill="var(--moch-user-bubble, #FAF1E7)">
        <path d="M 457 655 C 446 655, 439 646, 439 634 C 439 598, 468 572, 505 572 C 542 572, 571 598, 571 634 C 571 646, 564 655, 553 655 C 543 655, 537 646, 536 635 C 533 618, 521 608, 505 608 C 489 608, 477 618, 474 635 C 473 646, 467 655, 457 655 Z" />
        <path d="M 797 655 C 808 655, 815 646, 815 634 C 815 598, 786 572, 749 572 C 712 572, 683 598, 683 634 C 683 646, 690 655, 701 655 C 711 655, 717 646, 718 635 C 721 618, 733 608, 749 608 C 765 608, 777 618, 780 635 C 781 646, 787 655, 797 655 Z" />
      </g>
      <g fill="var(--moch-blush, #FA9B6A)">
        <ellipse cx="442" cy="695" rx="24" ry="12" transform="rotate(35 442 695)" />
        <ellipse cx="482" cy="705" rx="22" ry="12" transform="rotate(22 482 705)" />
        <ellipse cx="812" cy="695" rx="24" ry="12" transform="rotate(-35 812 695)" />
        <ellipse cx="772" cy="705" rx="22" ry="12" transform="rotate(-22 772 705)" />
      </g>
      <ellipse cx="790" cy="980" rx="52" ry="34" transform="rotate(-12 790 980)" fill="url(#mg-hand)" />
    </svg>
  )
}

/** Empty-state suggestion chips. Prompt chips draft text into the shared
 *  drafts store (the user reviews and sends); the slash chip drafts the
 *  command; "Browse" switches to the Skills screen via the shell. */
const SUGGESTIONS: { label: string; draft: string; cmd?: boolean }[] = [
  { label: 'Summarize my day', draft: 'Summarize what changed today across my chats and automations.' },
  { label: 'Research a topic', draft: 'Research this topic and write up what you find, with sources: ' },
  { label: '/cron add', draft: '/cron add ', cmd: true },
]

function EmptyChat(props: { onPick: (text: string) => void; onBrowse: () => void }) {
  return (
    <div className="moch-empty">
      <MochiMascot />
      <h1 className="moch-empty__title">Hey, I’m Moch</h1>
      <p className="moch-empty__sub">Your agent, running on your computer. Ask anything — or start from a command.</p>
      <div className="moch-empty__chips">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            className={s.cmd ? 'moch-chip moch-chip--cmd' : 'moch-chip'}
            onClick={() => props.onPick(s.draft)}
          >
            {s.label}
          </button>
        ))}
        <button type="button" className="moch-chip moch-chip--link" onClick={props.onBrowse}>
          Browse slash commands →
        </button>
      </div>
      <p className="moch-empty__hint">
        <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline · <kbd>Ctrl K</kbd> command palette
      </p>
    </div>
  )
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
  const allRows = useStore(sessionRows)
  const model = useStore(liveModel)
  const modelProvider = useStore(liveProvider)

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

  // Suggestion chips draft into the shared drafts store (same hand-off the
  // Skills screen uses) and focus the composer — the user reviews and sends.
  const pickSuggestion = useCallback(
    (text: string) => {
      setDraft(storedId, text)
      inputRef.current?.focus()
    },
    [storedId],
  )

  const summary = toolSummary(tls)
  const composerPlaceholder = busy ? 'Reply — queued until it finishes' : 'Message Moch'
  const sessionTitle = allRows.find((r) => r.id === storedId)?.title || 'New chat'
  const modelLabel = model ? (modelProvider ? `${modelProvider} / ${model}` : model) : 'default model'

  return (
    <div className="moch-chat">
      {banner ? (
        <button type="button" className="moch-banner" onClick={() => banner.retry?.()}>
          {banner.text}
        </button>
      ) : null}

      <header className="moch-chat__head">
        <span className="moch-chat__title">{sessionTitle}</span>
        <button
          type="button"
          className="moch-modelchip"
          onClick={() => setShellLayout({ screen: 'agent' })}
          title="Change model"
          aria-label={`Model: ${modelLabel}. Open Models to change it`}
        >
          <span className="moch-modelchip__dot" aria-hidden />
          {modelLabel}
        </button>
      </header>

      <div className="moch-chat__scrollwrap">
        <div className="moch-chat__scroll" ref={scrollRef} onScroll={readScroll}>
          <div className="moch-col moch-chat__col" ref={contentRef}>
            {msgs.length === 0 ? (
              booting ? (
                <div className="moch-booting">
                  <span className="moch-dots" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                  Loading chat…
                </div>
              ) : (
                <EmptyChat onPick={pickSuggestion} onBrowse={() => setShellLayout({ screen: 'skills' })} />
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
