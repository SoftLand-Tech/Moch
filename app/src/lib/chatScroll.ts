/**
 * Stick-to-bottom / follow policy for the chat transcript (BUG-102/103).
 *
 * The FlatList in app/(tabs)/chat.tsx is INVERTED (`data={reversedMsgs}`):
 * offset 0 is the visual bottom (the newest message, just above the
 * composer) and scrolling UP toward older history increases `y`. Long chats
 * therefore open at the latest message on frame 1 without measuring or
 * scrolling through older virtualized batches first.
 *
 * The policy itself is a PURE function of scroll metrics + streaming state,
 * extracted from chat.tsx (tracker BH-000031) so it can be pinned offline by
 * scripts/test-chat-scroll.ts: when the list stays glued to the newest
 * message, when the user has taken the wheel, and what to do when content
 * grows. chat.tsx keeps only the glue: refs, timers, the animated jump and
 * the quiet-window bookkeeping around programmatic scrolls.
 */

/** Snapshot of the inverted list's scroll geometry. */
export interface ScrollMetrics {
  /** contentOffset.y — 0 at the visual BOTTOM; grows toward older history. */
  y: number
  /** contentSize.height */
  contentH: number
  /** layoutMeasurement.height (the visible window; shrinks under the IME). */
  viewH: number
}

/** Inside this band of the bottom edge, the list counts as "pinned". */
export const STICK_BAND_PX = 120

export interface StickVerdict {
  /** Follow new content (streaming deltas, appends) as it arrives. */
  stick: boolean
  /** Show the jump-to-latest FAB. */
  showJump: boolean
}

/**
 * Judge the current position. Null when the metrics carry no verdict yet
 * (viewH 0, before first layout) — callers must HOLD their previous state,
 * exactly like the pre-extraction code did with its early return.
 *
 * Overscroll past the bottom makes `y` negative (still pinned), and short
 * chats that fit the viewport cannot scroll away from the bottom at all.
 */
export function evaluateStick(m: ScrollMetrics): StickVerdict | null {
  if (!m.viewH) return null
  const distance = m.contentH > 0 && m.contentH <= m.viewH ? 0 : Math.max(0, m.y)
  const nearBottom = distance < STICK_BAND_PX
  return { stick: nearBottom, showJump: !nearBottom }
}

/**
 * Should a content APPEND (new message, streaming delta) scroll back to the
 * bottom? Only when the user was pinned, has drifted within reach (y > 0 —
 * at exactly 0 new bubbles grow from the bottom edge natively and a program-
 * matic scroll is a no-op anyway), and no programmatic jump is mid-flight
 * (the quiet window suppresses the intermediate evaluations that would
 * cancel the stick mid-animation).
 */
export function shouldFollowOnAppend(
  m: Pick<ScrollMetrics, 'y'>,
  state: { stick: boolean; quietWindow: boolean },
): boolean {
  return state.stick && m.y > 0 && !state.quietWindow
}

/** What to do when the content size changes (a row mounted, a delta landed). */
export type ContentGrewAction =
  | 'follow' // pinned but drifted — pull back to the bottom edge
  | 'reevaluate' // user owns the position — recompute the pin verdict only
  | 'hold' // pinned at the edge — growth extends from the bottom natively

export function contentGrew(m: Pick<ScrollMetrics, 'y'>, stick: boolean): ContentGrewAction {
  if (stick && m.y > 0) return 'follow'
  if (!stick) return 'reevaluate'
  return 'hold'
}
