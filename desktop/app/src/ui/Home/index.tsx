/** Moch Desktop — Home. The Agent-mode landing view: hero composer over
 * the shared drafts store, the brand mascot greeting, six example-task
 * cards picked from the live slash catalog, and the active session's
 * recent activity (tools + todos). */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@nanostores/react'
import {
  activeStoredId,
  agentBusy,
  openLocalChatIfNeeded,
  sendPrompt,
  stopRun,
  todos,
  tools,
  type ToolItem,
  type TodoItem,
} from '../../../../../app/src/lib/chat'
import { enqueueSend } from '../../../../../app/src/lib/sendQueue'
import { commandCatalog, commandDescriptions, catalogWarning, loadCatalog, skillCommands } from '../../../../../app/src/lib/slash'
import { drafts, setDraft } from '../../../../../app/src/lib/drafts'
import { liveModel, liveProvider } from '../../../../../app/src/lib/modelState'
import { setShellLayout } from '../shell/state'
import { setComposerDraft } from '../../core/openSession'
import { Mascot } from './Mascot'
import { pickExampleTasks, type ExampleTask } from './examples'
import { IconArrowUp, IconChevronRight, IconStop } from './icons'
import './home.css'

function TaskCard(props: { task: ExampleTask; onRun: (t: ExampleTask) => void }) {
  const { task, onRun } = props
  const Icon = task.Icon
  return (
    <button type="button" className="moch-home__card" onClick={() => onRun(task)}>
      <span className="moch-home__card-icon">
        <Icon size={17} />
      </span>
      <span className="moch-home__card-body">
        <span className="moch-home__card-title">{task.title}</span>
        <span className="moch-home__card-blurb">{task.blurb}</span>
      </span>
      <span className="moch-home__card-chev">
        <IconChevronRight size={15} />
      </span>
    </button>
  )
}

function ActivityRow(props: { tool: ToolItem }) {
  const t = props.tool
  const dot =
    t.status === 'failed' ? 'moch-home__actdot moch-home__actdot--fail'
      : t.status === 'running' ? 'moch-home__actdot moch-home__actdot--run'
        : 'moch-home__actdot'
  return (
    <div className="moch-home__actrow">
      <span className={dot} aria-hidden />
      <span className="moch-home__actname">{t.name}</span>
      <span className="moch-home__actdetail">{t.preview ?? ''}</span>
      {t.durationS != null ? <span className="moch-home__actage">{t.durationS}s</span> : null}
    </div>
  )
}

function TodoRow(props: { todo: TodoItem }) {
  const t = props.todo
  const dot = t.done ? 'moch-home__actdot moch-home__actdot--tododone' : 'moch-home__actdot moch-home__actdot--todo'
  return (
    <div className="moch-home__actrow">
      <span className={dot} aria-hidden />
      <span className="moch-home__actdetail">{t.text}</span>
      {t.done ? <span className="moch-home__actage">done</span> : null}
    </div>
  )
}

export function Home(): React.JSX.Element {
  const storedId = useStore(activeStoredId)
  const draftsMap = useStore(drafts)
  const catalog = useStore(commandCatalog)
  const skills = useStore(skillCommands)
  const descriptions = useStore(commandDescriptions)
  const warning = useStore(catalogWarning)
  const tls = useStore(tools)
  const td = useStore(todos)
  const busy = useStore(agentBusy)
  const model = useStore(liveModel)
  const provider = useStore(liveProvider)

  // The composer keys its draft on the active session's STORED id. When the
  // screen lands on nothing (cold boot), open the fully-local new-chat
  // window — same contract the chat surface upholds; no server write until
  // the first send.
  useEffect(() => {
    openLocalChatIfNeeded()
  }, [])
  useEffect(() => {
    void loadCatalog().catch(() => {})
  }, [])

  // Typed text lives in the drafts atom keyed by stored id. Between landing
  // and that key existing (resume in flight, deep-link pending) typing rests
  // in local state and flushes the moment the key appears.
  const [resting, setResting] = useState('')
  useEffect(() => {
    if (storedId && resting) {
      setDraft(storedId, resting)
      setResting('')
    }
  }, [storedId, resting])
  const input = storedId ? (draftsMap[storedId] ?? '') : resting

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const updateInput = useCallback(
    (t: string) => {
      if (storedId) setDraft(storedId, t)
      else setResting(t)
    },
    [storedId],
  )

  // The chat surface's send contract: mid-turn sends queue on the visible
  // strip, otherwise clear-then-send with the text restored on failure.
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    if (busy) {
      if (!storedId) return
      const item = enqueueSend(storedId, text)
      if (!item) return
      updateInput('')
      return
    }
    updateInput('')
    try {
      await sendPrompt(text)
    } catch {
      updateInput(text)
    }
  }, [input, busy, storedId, updateInput])

  // Cards hand off the way the Skills screen does: draft on the active
  // chat's stored id, then focus the chat screen. No key yet → the shell's
  // composer-draft channel carries it.
  const runTask = useCallback((t: ExampleTask) => {
    const key = activeStoredId.get()
    if (key) setDraft(key, t.draft)
    else setComposerDraft(t.draft)
    setShellLayout({ screen: 'chat' })
  }, [])

  const tasks = useMemo(() => pickExampleTasks(catalog, skills, descriptions), [catalog, skills, descriptions])

  const modelLabel = model ? (provider ? `${provider} / ${model}` : model) : 'default model'
  const recentTools = useMemo(() => tls.slice(-8).reverse(), [tls])
  const recentTodos = useMemo(() => td.slice(0, 5), [td])
  const hasActivity = tls.length > 0 || td.length > 0

  return (
    <div className="moch-home">
      <div className="moch-home__col">
        <section className="moch-home__hero" aria-label="Compose a task">
          <div className="moch-home__composer">
            <textarea
              ref={inputRef}
              className="moch-home__input"
              value={input}
              rows={1}
              onChange={(e) => updateInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="What should Moch work on?"
              aria-label="Task input"
            />
            <div className="moch-home__rail">
              <button
                type="button"
                className="moch-home__chip"
                onClick={() => setShellLayout({ screen: 'agent' })}
                title="Change model"
                aria-label={`Model: ${modelLabel}. Open Models to change it`}
              >
                <span className="moch-home__chip-dot" aria-hidden />
                {modelLabel}
              </button>
              {busy ? (
                <button
                  type="button"
                  className="moch-home__send"
                  onClick={() => void stopRun()}
                  aria-label="Stop"
                >
                  <IconStop size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className="moch-home__send"
                  onClick={() => void send()}
                  disabled={!input.trim()}
                  aria-label="Send"
                >
                  <IconArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="moch-home__greeting">
          <Mascot size={96} />
          <h1 className="moch-home__title">Ready when you are</h1>
          <p className="moch-home__sub">
            Moch is connected and idle. Type a task above or start from an example — the run
            shows up on the right.
          </p>
        </section>

        <section className="moch-home__section" aria-label="Example tasks">
          <h2 className="moch-home__sechead">Example tasks</h2>
          {tasks.length > 0 ? (
            <div className="moch-home__grid">
              {tasks.map((t) => (
                <TaskCard key={t.name} task={t} onRun={runTask} />
              ))}
            </div>
          ) : warning ? (
            <div className="moch-home__catter">
              <span>Couldn’t load the command catalog{warning ? ` — ${warning}` : ''}.</span>
              <button type="button" className="moch-home__chip" onClick={() => setShellLayout({ screen: 'skills' })}>
                Browse skills instead →
              </button>
            </div>
          ) : (
            <div className="moch-home__catload">
              <span className="moch-home__dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              Loading the command catalog…
            </div>
          )}
        </section>

        {hasActivity ? (
          <section className="moch-home__section" aria-label="Recent activity">
            <h2 className="moch-home__sechead">Recent activity</h2>
            <div className="moch-home__activity">
              {recentTodos.map((t, i) => (
                <TodoRow key={`t${i}`} todo={t} />
              ))}
              {recentTools.map((t) => (
                <ActivityRow key={t.id} tool={t} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}

export default Home
