/**
 * useMochiState — the mascot's precedence waterfall.
 *
 * Subscribes to the app-signal stores and folds them into ONE MochiStateName
 * per instant, per the precedence field:
 *
 *   T0 head-pat (HOLD: after a 500ms finger-down delay the pat wins over
 *      everything — instant in after the delay, instant out on release.
 *      A tap shorter than the delay is a complete no-op: no wink, no
 *      switch — the current state keeps playing untouched)
 *   T1 critical  [error (momentary 3.8s) > approval > waiting-user > offline]
 *   T2 connecting
 *   T3 momentary overlays, NEWEST-first [notification, task-received,
 *      celebration, success, apologetic, idea, greeting, thank-you, shy,
 *      excited, confused, wink, head-pat-release (finger-up spring),
 *      waking-up]
 *   T4 live activity [speaking > listening > terminal > reading > working >
 *      deep-thinking > thinking > typing > waiting]
 *   T5 idle ladder [getting-sleepy 2.5min > sleeping 5min > low-battery]
 *   T6 mochi (base)
 *
 * MOMENT LATCH: mochiMoment/mochiSent are accepted only when their sid equals
 * activeSession AT LAND TIME; once accepted a moment plays to expiry no matter
 * where the user navigates. Expiry = loops × loopSec (loopSec from the studio
 * registry, bundled at build time).
 *
 * MIN-HOLD: every committed change except head-pat entry/exit and T1
 * error/approval/offline ENTRIES observes a 900ms dwell; a sooner desired
 * change parks and the LATEST desired wins when the dwell elapses.
 *
 * IDLE CLOCK: reset by a shallow-compared CHANGE in any subscribed store
 * value, an activityKey change, or a press. Mere re-evaluations producing
 * equal values do NOT reset it — the benign failure mode is Mochi staying
 * awake.
 *
 * OUTPUT: the committed state is published to the `mochiCommitted` atom,
 * which the Mascot leaf subscribes to. The 400ms heartbeat evaluates the
 * waterfall directly (no host re-render); only a real committed change
 * re-renders anything, and then only the 144px mascot box — never the Chat
 * screen (chat hot path).
 */
import { useCallback, useEffect, useRef } from 'react'
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'
import {
  MOCHI_STATES,
  type MochiStateName,
} from './mochiStates.gen'
import {
  activeDetached,
  activeQueue,
  activeSession,
  activeStoredId,
  agentBusy,
  chatBanner,
  messages,
  mochiMoment,
  mochiSent,
  pendingRequest,
  sessionLoadings,
  tools,
  type ChatMessage,
} from '../../lib/chat'
import { connectionState, isConnected } from '../../lib/gateway'
import { toasts } from '../../lib/attention'
import { ttsPlaying, voiceBusy } from '../../lib/voice'

/** The waterfall's committed output, as a store the Mascot LEAF subscribes
 *  to. The 400ms heartbeat evaluates the waterfall without re-rendering the
 *  host screen: a pass that changes nothing is invisible (nanostores skips
 *  set() with an Object.is-equal value), and one that changes the state
 *  re-renders only the 144px mascot box — never Chat. */
export const mochiCommitted = atom<MochiStateName>('mochi')

const MIN_HOLD_MS = 900
/** How long a finger must stay down before the hold becomes a pat. */
const PAT_DELAY_MS = 500
const DEEP_THINKING_MS = 10_000
const IDEA_AFTER_THINKING_MS = 3_000
const THANK_YOU_WINDOW_MS = 60_000
const SLEEPY_MS = 150_000 // 2.5 min
const SLEEP_MS = 300_000 // 5 min
const CELEBRATION_TURN_MS = 30_000

const TERMINAL_TOOL_RE = /bash|shell|command|exec|script|terminal|cmd/i
const READING_TOOL_RE = /web|fetch|read|browse|search|crawl|scrape|docs?/i

/** Verbatim from the state map. NOTE: \b is ASCII-only in JS, so the bare
 * 'شكرا' alternative only matches when surrounded by ASCII word chars — a
 * Latin-script neighbor. Flagged for the artist/i18n pass. */
const THANK_YOU_RE = /\b(thanks|thank you|thx|ty|shokran|شكرا)\b/i
const SHY_RE = /\b(good (job|bot|work)|nice|awesome|amazing|perfect|love (it|you)|❤️|😍|🔥)\b/iu

interface Moment {
  state: MochiStateName
  at: number
  expiresAt: number
}

/** loops × registry loopSec → expiry. loopSec provenance: the studio states
 *  registry parsed at build time (single source of truth). */
const loopsFor: Partial<Record<MochiStateName, number>> = {
  'mochi-notification': 1,
  'mochi-task-received': 1,
  'mochi-celebration': 2,
  'mochi-success': 1,
  'mochi-apologetic': 1,
  'mochi-idea': 1,
  'mochi-greeting': 1,
  'mochi-thank-you': 1,
  'mochi-shy': 1,
  'mochi-excited': 1,
  'mochi-confused': 1,
  'mochi-wink': 1,
  'mochi-waking-up': 0.5,
  'mochi-error': 1,
  'mochi-head-pat-release': 1,
}

const momentLoopSec = (state: MochiStateName) => MOCHI_STATES[state].loopSec

/** The tail streaming assistant row's LAST segment, or null. */
function tailStreamingSegment(list: ChatMessage[]): { msgId: string; kind: 'thinking' | 'text'; startedAt?: number } | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m.role === 'assistant' && m.streaming) {
      const segs = m.segments ?? []
      const last = segs[segs.length - 1]
      if (!last) return { msgId: m.id, kind: 'thinking' }
      if (last.kind === 'thinking') return { msgId: m.id, kind: 'thinking', startedAt: last.startedAt }
      if (last.kind === 'text') return { msgId: m.id, kind: 'text' }
      return null
    }
  }
  return null
}

const shallowArray = (a: readonly unknown[], b: readonly unknown[]) => {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const shallowValue = (a: unknown, b: unknown) => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return shallowArray(a, b)
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      const va = (a as Record<string, unknown>)[k]
      const vb = (b as Record<string, unknown>)[k]
      if (Array.isArray(va) && Array.isArray(vb)) {
        if (!shallowArray(va, vb)) return false
      } else if (va !== vb) return false
    }
    return true
  }
  return false
}

/** The waterfall's press bindings. The committed STATE is not carried here —
 *  the Mascot leaf reads `mochiCommitted` directly, so mascot switches never
 *  re-render the host screen. */
export interface UseMochiState {
  onPressIn: () => void
  onPressOut: () => void
}

export function useMochiState({ recording, activityKey }: { recording: boolean; activityKey: string }): UseMochiState {
  // ── subscriptions ─────────────────────────────────────────────────────────
  const busy = useStore(agentBusy)
  const msgs = useStore(messages)
  const toolItems = useStore(tools)
  const pending = useStore(pendingRequest)
  const queue = useStore(activeQueue)
  const activeId = useStore(activeSession)
  const storedId = useStore(activeStoredId)
  const conn = useStore(connectionState)
  const online = useStore(isConnected)
  const tts = useStore(ttsPlaying)
  const vBusy = useStore(voiceBusy)
  const toastList = useStore(toasts)
  const loadings = useStore(sessionLoadings)
  const banner = useStore(chatBanner)
  const detached = useStore(activeDetached)
  const momentAtom = useStore(mochiMoment)
  const sentAtom = useStore(mochiSent)

  // ── refs the waterfall reads ──────────────────────────────────────────────
  const committedRef = useRef<MochiStateName>('mochi')
  const lastCommitAtRef = useRef(0)
  const parkedRef = useRef<MochiStateName | null>(null)
  const pattingRef = useRef(false)
  const lastActivityRef = useRef(Date.now())
  const momentsRef = useRef<Moment[]>([])
  const busyStartRef = useRef(0)
  const prevBusyRef = useRef(false)
  const lastToastMaxRef = useRef<number | null>(null)
  const prevOnlineRef = useRef<boolean | null>(null)
  const prevBannerRef = useRef<unknown>(undefined)
  const prevDetachedRef = useRef<boolean | null>(null)
  const lastThankShyAtRef = useRef(0)
  const patTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A pat is a HELD press, not a touch: the first PAT_DELAY_MS of a hold
  // keep the current state (idle keeps breathing); only then does T0 take
  // over. Release before the threshold = never patted.
  useEffect(() => () => {
    if (patTimerRef.current) clearTimeout(patTimerRef.current)
  }, [])
  const ideaRef = useRef({ turnKey: '', thinkingSince: 0, fired: false })

  const pushMoment = useCallback((name: MochiStateName) => {
    const now = Date.now()
    const loops = loopsFor[name] ?? 1
    const m: Moment = { state: name, at: now, expiresAt: now + loops * momentLoopSec(name) * 1000 }
    momentsRef.current = [m, ...momentsRef.current].slice(0, 8)
  }, [])

  /** Expire moments — called on the ticker, keeps the ref from holding stale
   *  entries without re-rendering on its own. */
  const pruneMoments = useCallback(() => {
    const now = Date.now()
    if (momentsRef.current.some((m) => m.expiresAt <= now)) {
      momentsRef.current = momentsRef.current.filter((m) => m.expiresAt > now)
    }
  }, [])

  const noteActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
    // Sleep exits interpose waking-up (getting-sleepy exits do not); a
    // low-battery re-attach does too, per the map.
    if (committedRef.current === 'mochi-sleeping') pushMoment('mochi-waking-up')
  }, [pushMoment])

  // ── desired-state computation (pure read of the latest values) ────────────
  // Uses refs for values captured at each render so the ticker tick can call
  // it without re-subscribing.
  const latest = useRef({ busy, msgs, toolItems, pending, queue, activeId, conn, online, tts, vBusy, recording, detached, toastList })
  latest.current = { busy, msgs, toolItems, pending, queue, activeId, conn, online, tts, vBusy, recording, detached, toastList }

  const computeDesired = useCallback((now: number): MochiStateName => {
    const l = latest.current
    // T0 — hold wins over everything, instantly
    if (pattingRef.current) return 'mochi-head-pat'

    // T1 — critical. A live error moment outranks its expiry-free window.
    const nowMoments = momentsRef.current.filter((m) => m.expiresAt > now)
    if (nowMoments.some((m) => m.state === 'mochi-error')) return 'mochi-error'
    if (l.pending && (l.pending.method === 'approval' || l.pending.method === 'sudo' || l.pending.method === 'secret')) return 'mochi-approval'
    if (l.pending?.method === 'clarify') return 'mochi-waiting-user'
    // offline — identical to the connection overlay's `failed` predicate
    if (!l.online && (l.conn === 'error' || l.conn === 'closed')) return 'mochi-offline'

    // T2 — connecting
    if (!l.online && l.conn === 'connecting') return 'mochi-connecting'

    // T3 — momentary overlays, newest first
    const newest = nowMoments[0]
    if (newest) return newest.state

    // T4 — live activity
    if (l.tts) return 'mochi-speaking'
    if (l.recording) return 'mochi-listening'
    const running = l.toolItems.find((t) => t.status === 'running')
    if (l.busy && running) {
      if (TERMINAL_TOOL_RE.test(running.name)) return 'mochi-terminal'
      if (READING_TOOL_RE.test(running.name)) return 'mochi-reading'
      return 'mochi-working'
    }
    const tail = tailStreamingSegment(l.msgs)
    if (l.busy && tail?.kind === 'thinking') {
      const startedAt = tail.startedAt ?? now
      return now - startedAt >= DEEP_THINKING_MS ? 'mochi-deep-thinking' : 'mochi-thinking'
    }
    if (l.busy && tail?.kind === 'text') return 'mochi-typing'
    if (l.vBusy === 'transcribing') return 'mochi-thinking'
    if (l.busy && l.queue.length > 0) return 'mochi-waiting'

    // T5 — idle ladder (only reached with no T1-T4 signal)
    const idleMs = now - lastActivityRef.current
    if (idleMs >= SLEEP_MS) return 'mochi-sleeping'
    if (idleMs >= SLEEPY_MS) return 'mochi-getting-sleepy'
    if (l.detached) return 'mochi-low-battery'

    // T6 — base
    return 'mochi'
  }, [])

  const evaluate = useCallback((now: number = Date.now()) => {
    pruneMoments()
    const desired = computeDesired(now)
    if (desired === committedRef.current) {
      parkedRef.current = null
      return
    }
    // pat entry AND exit are instant both ways; T1 error/approval/offline
    // entries bypass the dwell too.
    const bypass =
      desired === 'mochi-head-pat' ||
      committedRef.current === 'mochi-head-pat' ||
      desired === 'mochi-error' ||
      desired === 'mochi-approval' ||
      desired === 'mochi-offline'
    if (bypass || now - lastCommitAtRef.current >= MIN_HOLD_MS) {
      committedRef.current = desired
      lastCommitAtRef.current = now
      parkedRef.current = null
      // Equal-value sets are skipped by nanostores, so this re-renders the
      // Mascot leaf only on a real switch — never the host screen.
      mochiCommitted.set(desired)
    } else {
      parkedRef.current = desired // latest desired wins when the dwell elapses
    }
  }, [computeDesired, pruneMoments])

  // Re-evaluate after every render — renders happen exactly when something
  // relevant changed (store emits, moment lands, press). The 400ms heartbeat
  // below is the only time-driven trigger and it evaluates WITHOUT a render.
  useEffect(() => {
    evaluate()
  })

  // Mount sync: this fresh instance starts committed at 'mochi', but the
  // shared atom may still hold a state from a previous mount (e.g. the chat
  // screen left mid-activity). Without this, a first pass whose desired is
  // 'mochi' would early-return and strand the leaf on the stale state.
  useEffect(() => {
    mochiCommitted.set(committedRef.current)
  }, [])

  // Heartbeat: moment expiry, ladder thresholds, dwell elapse, deep-thinking.
  // Calls evaluate() directly instead of force-ticking a host re-render: a
  // pass that changes nothing costs one pure computation, and one that
  // commits re-renders only the Mascot leaf through mochiCommitted.
  useEffect(() => {
    const t = setInterval(() => evaluate(), 400)
    return () => clearInterval(t)
  }, [evaluate])

  // busy start timestamp — the hook's own turn clock for success→celebration.
  useEffect(() => {
    if (busy && !prevBusyRef.current) busyStartRef.current = Date.now()
    prevBusyRef.current = busy
  }, [busy])

  // ── moment intake (LAND-TIME sid latch) ───────────────────────────────────
  useEffect(() => {
    if (!momentAtom) return
    if (momentAtom.sid !== activeSession.get()) return // background chat — suppressed
    const { kind, at } = momentAtom
    if (kind === 'success') {
      const elapsed = at - (busyStartRef.current || at)
      pushMoment(elapsed >= CELEBRATION_TURN_MS ? 'mochi-celebration' : 'mochi-success')
    } else {
      const name: MochiStateName =
        kind === 'error' ? 'mochi-error' : kind === 'greeting' ? 'mochi-greeting' : kind === 'apologetic' ? 'mochi-apologetic' : 'mochi-celebration'
      pushMoment(name)
    }
  }, [momentAtom, pushMoment])

  // ── mochiSent intake: thank-you > shy (1/60s) > task-received ────────────
  useEffect(() => {
    if (!sentAtom) return
    if (sentAtom.sid !== activeSession.get()) return
    const now = Date.now()
    if (THANK_YOU_RE.test(sentAtom.text)) {
      if (now - lastThankShyAtRef.current >= THANK_YOU_WINDOW_MS) {
        lastThankShyAtRef.current = now
        pushMoment('mochi-thank-you')
        return
      }
    } else if (SHY_RE.test(sentAtom.text)) {
      if (now - lastThankShyAtRef.current >= THANK_YOU_WINDOW_MS) {
        lastThankShyAtRef.current = now
        pushMoment('mochi-shy')
        return
      }
    }
    pushMoment('mochi-task-received')
  }, [sentAtom, pushMoment])

  // ── notification: newest-toast-id INCREASES (verbatim blocker predicate) ──
  // pushToast filter-replaces same storedId+kind (no length change), caps via
  // slice(-3) (eviction, no length change) — but every push gets ++toastSeq,
  // so the MAX ID is the only honest observable. Dismissals lower the max
  // without ever firing.
  useEffect(() => {
    const maxId = toastList.reduce((n, t) => Math.max(n, t.id), 0)
    if (lastToastMaxRef.current === null) {
      lastToastMaxRef.current = maxId
      return
    }
    if (maxId > lastToastMaxRef.current) {
      lastToastMaxRef.current = maxId
      pushMoment('mochi-notification')
    } else {
      lastToastMaxRef.current = Math.max(lastToastMaxRef.current, maxId)
    }
  }, [toastList, pushMoment])

  // ── excited: reconnect edge after a disconnect ────────────────────────────
  useEffect(() => {
    if (prevOnlineRef.current === null) {
      prevOnlineRef.current = online
      return
    }
    if (!prevOnlineRef.current && online) pushMoment('mochi-excited')
    prevOnlineRef.current = online
  }, [online, pushMoment])

  // ── confused: chatBanner null→set (first observation never fires) ─────────
  useEffect(() => {
    if (prevBannerRef.current !== undefined && prevBannerRef.current === null && banner !== null) {
      pushMoment('mochi-confused')
    }
    prevBannerRef.current = banner
  }, [banner, pushMoment])

  // ── low-battery exit: detached true→false wakes through waking-up ─────────
  useEffect(() => {
    if (prevDetachedRef.current === null) {
      prevDetachedRef.current = detached
      return
    }
    if (prevDetachedRef.current && !detached && committedRef.current === 'mochi-low-battery') {
      pushMoment('mochi-waking-up')
    }
    prevDetachedRef.current = detached
  }, [detached, pushMoment])

  // ── idea: first text delta after ≥3s of continuous thinking, once per turn
  useEffect(() => {
    const tail = tailStreamingSegment(msgs)
    const r = ideaRef.current
    if (!tail || !busy) {
      if (!tail) r.thinkingSince = 0
      return
    }
    if (tail.msgId !== r.turnKey) {
      r.turnKey = tail.msgId
      r.thinkingSince = 0
      r.fired = false
    }
    if (tail.kind === 'thinking') {
      if (!r.thinkingSince) r.thinkingSince = tail.startedAt ?? Date.now()
    } else if (tail.kind === 'text' && r.thinkingSince && !r.fired) {
      if (Date.now() - r.thinkingSince >= IDEA_AFTER_THINKING_MS) {
        r.fired = true
        r.thinkingSince = 0
        pushMoment('mochi-idea')
      }
    }
  }, [msgs, busy, pushMoment])

  // ── idle clock: a shallow-compared CHANGE in any subscribed value ─────────
  const snapshot = [
    busy, msgs, toolItems, pending, queue, activeId, storedId, conn, online,
    tts, vBusy, toastList, loadings, banner, detached, recording, activityKey,
  ]
  const prevSnapshotRef = useRef<typeof snapshot | null>(null)
  useEffect(() => {
    const prev = prevSnapshotRef.current
    prevSnapshotRef.current = snapshot
    if (!prev) return
    for (let i = 0; i < snapshot.length; i++) {
      if (!shallowValue(prev[i], snapshot[i])) {
        noteActivity()
        break
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...snapshot])

  // ── press (T0) ────────────────────────────────────────────────────────────
  // A tap does NOTHING: no wink, no state switch, not even an idle-clock
  // reset — Mochi keeps whatever animation he is running (working, sleeping,
  // …). Only a hold past PAT_DELAY_MS becomes a pat, and only a real pat
  // counts as interaction (wakes sleepers, ends with the release spring).
  const onPressIn = useCallback(() => {
    patTimerRef.current = setTimeout(() => {
      patTimerRef.current = null
      pattingRef.current = true
      noteActivity()
      evaluate()
    }, PAT_DELAY_MS)
  }, [noteActivity, evaluate])

  const onPressOut = useCallback(() => {
    const wasPatting = pattingRef.current
    if (patTimerRef.current) {
      clearTimeout(patTimerRef.current)
      patTimerRef.current = null
    }
    pattingRef.current = false
    if (wasPatting) {
      noteActivity()
      // The pat ends with the dough SPRINGING back, not a hard cut: the
      // release state is a 0.55s one-shot whose 0% frame is exactly the held
      // squish pose (T3 moment; entry bypasses the dwell because we're exiting
      // head-pat, and it expires straight into the next waterfall state).
      pushMoment('mochi-head-pat-release')
    }
    evaluate()
  }, [noteActivity, evaluate, pushMoment])

  return { onPressIn, onPressOut }
}
