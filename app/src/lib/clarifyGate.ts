/**
 * Batch-clarify send gate (BH-000025), node-safe so the truth table lives in
 * scripts/test-queue.ts. The wire contract is unforgiving: a batch answer
 * frame carries whatever map it is given, and the server maps every MISSING
 * qid to "" with no timed_out flag (clarify_tool.py::_batch_result reads
 * that as a DELIBERATE skip) — then retires the question. A Send tap with
 * unanswered questions therefore silently tells the agent the user chose to
 * skip them, unrecoverably.
 */

/** Structural slice of PendingRequest['questions'] — no chat.ts import
 *  (chat.ts cannot load in plain node). */
export interface ClarifyQuestion {
  qid: string
  choices?: string[]
  multi_select?: boolean
}

/** One answer value: a typed string (single pick / free text) or the
 *  selected choices of a multi-select question. */
export type ClarifyAnswer = string | string[]

/** True when `v` holds a real answer for a single-answer question. */
function hasText(v: ClarifyAnswer | undefined): boolean {
  return typeof v === 'string' ? v.trim().length > 0 : false
}

/** True when `v` holds at least one non-empty selection (multi-select). */
function hasSelection(v: ClarifyAnswer | undefined): boolean {
  if (Array.isArray(v)) return v.some((x) => x.trim().length > 0)
  return hasText(v)
}

/** May the batch Send button fire? EVERY question needs an answer: a
 *  non-empty string for plain questions, at least one non-empty selection
 *  for multi_select ones. An empty string counts as unanswered. */
export function batchReady(questions: ClarifyQuestion[], answers: Record<string, ClarifyAnswer>): boolean {
  return countUnanswered(questions, answers) === 0
}

/** How many questions still lack an answer — the hint line's count. */
export function countUnanswered(questions: ClarifyQuestion[], answers: Record<string, ClarifyAnswer>): number {
  let n = 0
  for (const q of questions) {
    const v = answers[q.qid]
    if (q.multi_select ? !hasSelection(v) : !hasText(v)) n++
  }
  return n
}
