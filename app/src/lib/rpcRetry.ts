/**
 * Retry policy for gateway RPC failures (BUG-036, client half).
 *
 * Pure and node-safe on purpose: the truth table lives in unit tests
 * (scripts/test-queue.ts), and chat.ts itself cannot load in plain node
 * (react-native/AsyncStorage at import time) — so every automated-retry
 * decision funnels through these tiny helpers instead of living inline.
 */
import { GatewayTimeoutError } from '../protocol/json-rpc-channel'

/** Which leg of a send failed. 'resolve' = obtaining a live session
 *  (create/resume/reattach). 'submit' = the prompt.submit itself. */
export type RpcPhase = 'resolve' | 'submit'

/** True only for typed channel timeouts — classification is BY TYPE, never
 *  by message text: a plain Error (or a JsonRpcGatewayError) that happens to
 *  say "timeout" was not a sent-but-unanswered frame. */
export function isGatewayTimeout(err: unknown): err is GatewayTimeoutError {
  return err instanceof GatewayTimeoutError
}

/**
 * chat.ts wraps a submit-phase GatewayTimeoutError in this before rethrowing,
 * so automated paths (busy-queue flush, outbox flush) can tell
 * "maybe delivered — never resubmit on its own" apart from every retryable
 * failure without knowing which phase they were in.
 */
export class UnconfirmedSubmitError extends Error {
  /** The method that timed out (always a submit-family call). */
  readonly method: string
  /** The underlying timeout, for logging/handling at the call site. */
  readonly timeout: GatewayTimeoutError

  constructor(timeout: GatewayTimeoutError) {
    super(timeout.message)
    this.name = 'UnconfirmedSubmitError'
    this.method = timeout.method
    this.timeout = timeout
  }
}

export function isUnconfirmedSubmit(err: unknown): err is UnconfirmedSubmitError {
  return err instanceof UnconfirmedSubmitError
}

/**
 * May an AUTOMATED path (queue flush, outbox flush, reconnect retry) re-fire
 * this call on its own?
 *
 *  - submit-phase GatewayTimeoutError → NO. The prompt.submit frame was
 *    already on the wire when the 120s deadline rejected the local promise;
 *    the turn may be running right now, and the server's own turn events
 *    re-release the queue — a blind resubmit duplicates the user's text with
 *    zero user action. The visible row keeps an 'unconfirmed' marker and the
 *    USER decides (manual retry, with a warning).
 *  - everything else → YES. A resolve-phase timeout sent no prompt at all,
 *    a JSON-RPC error is a definitive "not delivered", and offline throws
 *    never left the device.
 */
export function shouldAutoRetry(phase: RpcPhase, error: unknown): boolean {
  if (isUnconfirmedSubmit(error)) return false
  return !(phase === 'submit' && isGatewayTimeout(error))
}

/**
 * Outbox pin policy (BH-000018): an offline-enqueued text must never be
 * pinned to a pseudo stored id (`new:…` — the optimistic new-chat window's
 * stand-in). flushOutbox can neither find a live entry for a pseudo id nor
 * resume one, so a pseudo-pinned item sat undeliverable forever; fall back
 * to the unpinned contract (deliver to whichever chat is active at flush
 * time), same as a legacy `storedId: ''` entry.
 */
export function outboxPinFor(storedId: string | undefined): string {
  if (!storedId) return ''
  return storedId.startsWith('new:') ? '' : storedId
}

/** What flushOutbox should do with one outbox item (BH-000019).
 *  - 'origin'  — the chat the text was COMPOSED in is still tracked under its
 *    own live/temp id (an optimistic new-chat window that never left the
 *    screen): resolve through THAT window, never the flush-time active chat.
 *  - 'pinned'  — a real stored id pin (BUG-008): deliver to that chat,
 *    resuming it quietly if no live entry tracks it.
 *  - 'active'  — legacy unpinned contract: whichever chat is active at flush
 *    time (a swept window, a restarted app, a pre-origin install). */
export type OutboxTarget =
  | { kind: 'origin'; id: string }
  | { kind: 'pinned'; storedId: string }
  | { kind: 'active' }

/**
 * Pure routing decision for one outbox item, so the truth table lives in
 * test-queue.ts. `sessionsByIdKeys` is the CURRENT key set of the session
 * map — an origin id that no longer names a tracked window (swept by a newer
 * newChat, re-keyed by its own successful create, or lost to a restart)
 * falls back to the pinned/unpinned contract instead of a dead reference.
 */
export function outboxTargetFor(
  item: { storedId?: string; originId?: string },
  sessionsByIdKeys: ReadonlySet<string>,
): OutboxTarget {
  if (item.originId && sessionsByIdKeys.has(item.originId)) {
    return { kind: 'origin', id: item.originId }
  }
  if (item.storedId) return { kind: 'pinned', storedId: item.storedId }
  return { kind: 'active' }
}
