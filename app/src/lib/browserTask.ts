import { atom } from 'nanostores'
import { createSession, sendPrompt, sessionsById, thinkerForChat } from './chat'
import { rpc } from './gateway'
import { ocInterrupt } from './opencodeClient'
import { ocSessionFor } from './opencodeChat'
import { ackHandoff, handoffRequestAtom } from './browserRelay'
import { log } from './log'

/**
 * Browser quick task — "Ask Moch" on the Browser screen runs as a NORMAL
 * background chat:
 *
 *  - `createSession()` mints a Hermes (or OpenCode) spine without activating
 *    it (no newChat / switchToSession / shareInInbox / navigation);
 *  - `sendPrompt(prompt, { session: liveId })` pins the turn to that spine, so
 *    the user stays on the page and the active chat never changes;
 *  - the status row derives from `sessionsById`: starting → running →
 *    done|failed|stopped|user. `done` is the busy edge the turn itself emits,
 *    never a timer;
 *  - Stop / Take over interrupt the RIGHT brain: OpenCode via
 *    ocSessionFor(storedId) + ocInterrupt, Hermes via session.interrupt.
 *
 * The screen stays mounted while the user changes tabs, so the task keeps
 * running; the atom is the single source of truth for the status strip.
 */

export type BrowserTaskStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped' | 'user'

export interface BrowserTaskTab {
  id: string
  url: string
  title: string
}

export interface BrowserTaskState {
  status: BrowserTaskStatus
  /** The user's ask, shown in the status strip. */
  task: string
  /** Page identity captured when the task started. */
  title: string
  url: string
  tabId: string
  /** Live gateway id once createSession lands; null while starting. */
  liveId: string | null
  /** Durable id (for the OpenCode session map + the thinker lookup). */
  storedId: string | null
  startedAt: number
  error?: string | null
  /** i18n key for a local control failure (raw gateway errors stay in `error`). */
  errorKey?: string | null
}

export const browserTaskAtom = atom<BrowserTaskState | null>(null)

/** Monotonic run token: a newer task (or a stop) invalidates old continuations. */
let runSeq = 0

interface TaskWatch {
  stop(): void
  /** After sendPrompt resolves: reconcile from the store's busy flag. */
  reconcile(): void
}

let activeWatch: TaskWatch | null = null

function stopWatch() {
  activeWatch?.stop()
  activeWatch = null
}

function isActiveStatus(status: BrowserTaskStatus): boolean {
  return status === 'starting' || status === 'running'
}

/**
 * The prompt is model-facing (not UI) and deliberately names the current page
 * plus the exact handoff tool the model must use when a human is required.
 */
export function buildBrowserTaskPrompt(task: string, tab: BrowserTaskTab): string {
  const title = tab.title || tab.url
  return [
    'You are running a background browser task inside the Moch app. The user stays on the web page while you work; do not ask them to open the chat screen.',
    '',
    `Page title: ${title}`,
    `Page URL: ${tab.url}`,
    `Task: ${task}`,
    '',
    'Drive the CURRENT Moch Browser tab with the browser tools (browser_snapshot, browser_click, browser_type, browser_navigate). Stay on this tab: do not open, close, or switch tabs, and do not navigate away unless the task truly requires it.',
    'When you hit a login wall, a CAPTCHA, a payment step, or any destructive/irreversible confirmation that needs the human, call browser_request_handoff with a short reason instead of forcing it.',
    'If the handoff is accepted, the human now owns the browser: stop driving it and wait for a new instruction. If it is declined or times out, control was not handed over — continue only when it is safe, otherwise say what is blocked.',
    'Report the outcome in this conversation when you are done.',
  ].join('\n')
}

/**
 * Watch the pinned session's busy edge. `seenBusy` guards the done inference:
 * a session that never went busy is not "done" (it failed to start, handled by
 * the send's catch), while busy → idle IS the turn-end signal.
 */
function armTaskWatch(run: number, liveId: string, storedId: string): TaskWatch {
  let seenBusy = false
  let currentLive = liveId
  let stopped = false
  let off: () => void = () => {}

  const read = () => {
    const map = sessionsById.get()
    if (currentLive && map[currentLive]) return map[currentLive]
    return Object.values(map).find((s) => s.storedId === storedId)
  }

  const watch: TaskWatch = {
    stop() {
      if (stopped) return
      stopped = true
      off()
    },
    reconcile() {
      if (stopped || run !== runSeq) return
      const cur = browserTaskAtom.get()
      if (!cur || !isActiveStatus(cur.status)) return
      const s = read()
      if (s?.busy) {
        seenBusy = true
        if (browserTaskAtom.get()?.status === 'starting') {
          browserTaskAtom.set({ ...browserTaskAtom.get()!, status: 'running' })
        }
        return
      }
      // sendPrompt resolved and the session is idle: the turn submitted, then
      // ended before/while this ran (OpenCode awaits the whole turn).
      if (seenBusy || cur.status === 'running' || cur.status === 'starting') {
        browserTaskAtom.set({ ...browserTaskAtom.get()!, status: 'done' })
        watch.stop()
      }
    },
  }

  off = sessionsById.listen((map) => {
    if (stopped || run !== runSeq) return
    const cur = browserTaskAtom.get()
    if (!cur || !isActiveStatus(cur.status)) {
      watch.stop()
      return
    }
    let s = currentLive ? map[currentLive] : undefined
    if (!s) {
      s = Object.values(map).find((x) => x.storedId === storedId)
      if (s && s.id !== currentLive) {
        currentLive = s.id
        const now = browserTaskAtom.get()
        if (now && now.liveId !== s.id) browserTaskAtom.set({ ...now, liveId: s.id })
      }
    }
    if (s?.busy) {
      seenBusy = true
      const now = browserTaskAtom.get()
      if (now && now.status === 'starting') browserTaskAtom.set({ ...now, status: 'running' })
    } else if (seenBusy) {
      const now = browserTaskAtom.get()
      if (now && isActiveStatus(now.status)) browserTaskAtom.set({ ...now, status: 'done' })
      watch.stop()
    }
  })
  // The immediate subscribe callback above runs BEFORE `off` gets its real
  // unsubscriber; release it now if that first pass already ended the watch.
  if (stopped) off()

  activeWatch = watch
  return watch
}

/** Stop the right brain for a pinned session; never throws. Returns whether
 *  the interrupt actually landed, so callers never claim a false stop. */
async function interruptTaskSession(state: Pick<BrowserTaskState, 'liveId' | 'storedId'>): Promise<boolean> {
  const liveId = state.liveId
  // Nothing was submitted yet: there is no turn to interrupt.
  if (!liveId) return true
  try {
    if (state.storedId && thinkerForChat(state.storedId) === 'opencode') {
      const ocId = await ocSessionFor(state.storedId)
      if (ocId) await ocInterrupt(ocId)
      return true
    }
    await rpc('session.interrupt', { session_id: liveId })
    return true
  } catch (e) {
    log('warn', 'browserTask', `interrupt failed: ${e}`)
    return false
  }
}

/**
 * Start a background browser task. Returns when the prompt was submitted (or
 * failed to submit); the turn itself keeps running in the pinned session.
 */
export async function startBrowserTask(task0: string, tab: BrowserTaskTab): Promise<void> {
  const task = task0.trim()
  if (!task || !tab?.id) return

  const prev = browserTaskAtom.get()
  if (prev && (isActiveStatus(prev.status) || (prev.status === 'user' && prev.liveId))) {
    // One quick task at a time. Wait for the previous turn's interrupt to land
    // before minting the next session; two sessions must never drive one tab.
    let stopped = true
    if (isActiveStatus(prev.status)) {
      await stopBrowserTask()
    } else {
      // A tool handoff deliberately did not kill the turn. Starting a new
      // task is the explicit "done with the old one" signal.
      stopped = await interruptTaskSession(prev)
    }
    const afterStop = browserTaskAtom.get()
    if (!stopped || (afterStop && isActiveStatus(afterStop.status))) {
      if (afterStop) {
        browserTaskAtom.set({
          ...afterStop,
          status: 'failed',
          error: null,
          errorKey: 'browser.task.prevStopFailed',
        })
      }
      return
    }
  }

  const run = ++runSeq
  stopWatch()
  browserTaskAtom.set({
    status: 'starting',
    task,
    title: tab.title || tab.url,
    url: tab.url,
    tabId: tab.id,
    liveId: null,
    storedId: null,
    startedAt: Date.now(),
    error: null,
    errorKey: null,
  })

  try {
    // A descriptive drawer title, but still a normal background spine: the
    // caller (this module) never activates it, so the user's current chat and
    // current screen stay exactly where they are. background:true keeps it
    // from replacing the app's next-boot "last session".
    const created = await createSession(`Browser · ${(tab.title || tab.url).slice(0, 64)}`, { background: true })
    if (run !== runSeq) {
      // Superseded by a newer task: this spine was never used.
      void interruptTaskSession({ liveId: created.sessionId, storedId: created.storedId })
      return
    }
    const cur = browserTaskAtom.get()
    if (!cur || cur.status !== 'starting') {
      // Stop/takeover landed while session.create was in flight — no turn was
      // started, so there is nothing to send.
      return
    }
    browserTaskAtom.set({ ...cur, liveId: created.sessionId, storedId: created.storedId })
    armTaskWatch(run, created.sessionId, created.storedId)
    if (browserTaskAtom.get()?.status !== 'starting') {
      stopWatch()
      void interruptTaskSession(browserTaskAtom.get()!)
      return
    }
    await sendPrompt(buildBrowserTaskPrompt(task, tab), { session: created.sessionId })
    if (run !== runSeq) return
    const afterSend = browserTaskAtom.get()
    if (!afterSend) return
    if (afterSend.status === 'stopped' || afterSend.status === 'user') {
      // Stop/Take over landed while prompt.submit was in flight. The turn may
      // have been submitted after that first interrupt, so interrupt once more
      // with the now-known live id.
      void interruptTaskSession({ liveId: created.sessionId, storedId: created.storedId })
      return
    }
    if (!isActiveStatus(afterSend.status)) return // done/failed already settled
    activeWatch?.reconcile()
  } catch (e) {
    if (run !== runSeq) return
    const cur = browserTaskAtom.get()
    // The user's stop/takeover is the final word. Otherwise a rejected send is
    // a failure even if the busy edge briefly inferred "done" on its way out.
    if (!cur || cur.status === 'stopped' || cur.status === 'user') return
    stopWatch()
    browserTaskAtom.set({
      ...cur,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
      errorKey: null,
    })
  }
}

/** Manual Stop: interrupts the turn and marks the strip stopped. */
export async function stopBrowserTask(): Promise<void> {
  const cur = browserTaskAtom.get()
  if (!cur || !isActiveStatus(cur.status)) return
  // A blocked handoff tool must learn that control was not handed over.
  // Otherwise its global prompt outlives the stop and looks frozen.
  const pending = handoffRequestAtom.get()
  if (pending) ackHandoff(pending.requestId, false)
  stopWatch()
  // Commit the status only after the interrupt lands. An offline/racing
  // gateway must not leave the strip claiming a stopped agent.
  const stopped = await interruptTaskSession(cur)
  const now = browserTaskAtom.get()
  if (!now || now.startedAt !== cur.startedAt) return
  browserTaskAtom.set(
    stopped
      ? { ...now, status: 'stopped', error: null, errorKey: null }
      : { ...now, status: 'running', error: null, errorKey: 'browser.task.stopFailed' },
  )
}

/**
 * Manual Take over: the human takes the page. Accepts a pending tool handoff
 * first (so the model is told the human owns the browser), interrupts the
 * quick task, and marks the strip under user control. The WebView stays
 * mounted and fully usable — no overlay intercepts it.
 */
export async function takeoverBrowserTask(): Promise<void> {
  const pending = handoffRequestAtom.get()
  if (pending) ackHandoff(pending.requestId, true)

  const cur = browserTaskAtom.get()
  if (!cur) return
  if (!isActiveStatus(cur.status)) return
  stopWatch()
  const stopped = await interruptTaskSession(cur)
  const now = browserTaskAtom.get()
  if (!now || now.startedAt !== cur.startedAt) return
  browserTaskAtom.set(
    stopped
      ? { ...now, status: 'user', error: null, errorKey: null }
      : { ...now, status: 'running', error: null, errorKey: 'browser.task.takeoverFailed' },
  )
}

/**
 * A tool-triggered handoff was accepted from the global prompt. The session is
 * NOT killed (the tool result tells the model to stop driving); the strip just
 * reflects that the human has the browser now.
 */
export function markBrowserUserControl(): void {
  const cur = browserTaskAtom.get()
  if (!cur || !isActiveStatus(cur.status)) return
  stopWatch()
  browserTaskAtom.set({ ...cur, status: 'user' })
}

/** Clear a finished/failed/stopped/user strip. */
export function dismissBrowserTask(): void {
  const cur = browserTaskAtom.get()
  if (!cur || isActiveStatus(cur.status)) return
  browserTaskAtom.set(null)
}
