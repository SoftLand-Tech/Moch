/**
 * Pure OpenCode turn watchdog & reconnect policy helpers — NO React Native /
 * AsyncStorage imports, so `scripts/test-oc-turn.ts` can verify timeout and
 * reconnect transitions under plain tsx.
 */

/** Idle LLM step gap / first-token silence patience before probing server (3m). */
export const OC_IDLE_SILENCE_MS = 180_000
/** Tool execution / input generation / compaction silence patience (10m). */
export const OC_TOOL_SILENCE_MS = 600_000
/** Extra grace added past an OpenCode `session.retry.scheduled` deadline (3m). */
export const OC_RETRY_BUFFER_MS = 180_000
/** Activity-sliding turn inactivity cap (45m without any SSE event). */
export const OC_ACTIVITY_CAP_MS = 45 * 60 * 1000
/** Max consecutive SSE reconnect attempts before declaring a stalled turn. */
export const OC_MAX_RECONNECT_ATTEMPTS = 20
/** Exponential backoff for SSE reconnects; the first retry is immediate-ish. */
export const OC_RECONNECT_BASE_MS = 250
export const OC_RECONNECT_MAX_MS = 5_000

export function ocReconnectDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(OC_RECONNECT_MAX_MS, OC_RECONNECT_BASE_MS * 2 ** Math.min(n, 16))
}

export interface OcSilenceState {
  awaitingUserCount: number
  activeToolCount: number
  compacting: boolean
  retryAtMs?: number | null
  nowMs?: number
}

/**
 * Compute the current SSE silence limit in ms, or `null` when paused
 * (waiting on human permission / question form input).
 */
export function computeOcSilenceLimitMs(state: OcSilenceState): number | null {
  if (state.awaitingUserCount > 0) return null
  let limit = state.activeToolCount > 0 || state.compacting ? OC_TOOL_SILENCE_MS : OC_IDLE_SILENCE_MS
  const now = state.nowMs ?? Date.now()
  if (typeof state.retryAtMs === 'number' && Number.isFinite(state.retryAtMs) && state.retryAtMs > now) {
    limit = Math.max(limit, state.retryAtMs - now + OC_RETRY_BUFFER_MS)
  }
  return limit
}

export interface OcDisconnectDecisionInput {
  cancelled: boolean
  turnDone: boolean
  winner: 'dropped' | 'silent'
  hasActivity: boolean
  lastSilenceLimitMs: number
  pendingFormCount: number
  sessionActive: boolean | null
  sessionOutcome?: 'succeeded' | 'failed' | 'interrupted' | string
  sessionIdle?: boolean
  rebindCount: number
  existingError?: string
  streamErrorText?: string
}

export type OcDisconnectDecision =
  | { kind: 'reconnect'; reason: 'awaiting-form' | 'server-running' | 'server-probe-unknown'; countRebind: boolean }
  | { kind: 'complete'; failed: boolean; errorMsg?: string; syncHistory: boolean }
  | { kind: 'fail'; message: string }

/**
 * Decide what `runOpencodeTurn` should do when the SSE stream drops or hits its
 * silence watchdog before a terminal SSE event arrives.
 */
export function decideOcDisconnectAction(input: OcDisconnectDecisionInput): OcDisconnectDecision {
  if (input.cancelled) {
    return { kind: 'complete', failed: false, syncHistory: false }
  }
  if (input.turnDone) {
    return {
      kind: 'complete',
      failed: !!input.existingError,
      errorMsg: input.existingError,
      syncHistory: false,
    }
  }
  if (input.pendingFormCount > 0) {
    if (input.rebindCount < OC_MAX_RECONNECT_ATTEMPTS) {
      return { kind: 'reconnect', reason: 'awaiting-form', countRebind: true }
    }
    return {
      kind: 'fail',
      message: input.existingError ?? 'OpenCode is waiting for input, but the event stream could not be restored',
    }
  }
  if (input.sessionActive === true) {
    if (input.rebindCount < OC_MAX_RECONNECT_ATTEMPTS) {
      return { kind: 'reconnect', reason: 'server-running', countRebind: true }
    }
    return {
      kind: 'fail',
      message:
        input.existingError ??
        `The model stopped responding (no events for ${Math.round(input.lastSilenceLimitMs / 1000)}s, ${input.hasActivity ? 'mid-answer' : 'before any output'})`,
    }
  }
  // An unknown probe result is NOT evidence that the session finished. The
  // session's outcome/idle fields can describe the previous execution while a
  // new turn is still running, so only a successful negative active probe may
  // trust them below.
  if (input.sessionActive === null) {
    if (input.rebindCount < OC_MAX_RECONNECT_ATTEMPTS) {
      return { kind: 'reconnect', reason: 'server-probe-unknown', countRebind: true }
    }
    return {
      kind: 'fail',
      message: input.existingError ?? 'Could not verify whether the OpenCode session is still running',
    }
  }
  if (input.sessionOutcome === 'succeeded') {
    return { kind: 'complete', failed: false, syncHistory: true }
  }
  if (input.sessionOutcome === 'interrupted') {
    return {
      kind: 'complete',
      failed: !!input.existingError,
      errorMsg: input.existingError,
      syncHistory: true,
    }
  }
  if (input.sessionOutcome === 'failed') {
    return {
      kind: 'fail',
      message: input.existingError ?? 'The turn failed',
    }
  }
  if (input.sessionIdle && input.sessionActive === false) {
    return {
      kind: 'complete',
      failed: !!input.existingError,
      errorMsg: input.existingError,
      syncHistory: true,
    }
  }
  const fallback =
    input.winner === 'silent'
      ? `The model stopped responding (no events for ${Math.round(input.lastSilenceLimitMs / 1000)}s, ${input.hasActivity ? 'mid-answer' : 'before any output'})`
      : input.streamErrorText
        ? `The OpenCode connection dropped mid-turn — ${input.streamErrorText}`
        : 'The OpenCode connection dropped mid-turn'
  return {
    kind: 'fail',
    message: input.existingError ?? fallback,
  }
}
