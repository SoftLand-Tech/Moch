/**
 * Pure history merging & turn-grouping helpers — NO React Native / AsyncStorage
 * imports, so `scripts/test-history-merge.ts` can verify every edge case directly.
 *
 * Solves two bugs:
 * 1. Consecutive assistant step rows in server history (multi-tool turns,
 *    interim commentary, length continuations) are merged into ONE assistant
 *    bubble between user turns, matching live streaming and `ocHistory.ts`.
 * 2. Reconciling server history on `session.resume` / mid-turn switch back
 *    preserves any local unpersisted trailing user messages, failed/unconfirmed
 *    user messages, active streaming assistant tails, command cards, and
 *    `res.inflight` turn snapshots from the gateway.
 */

export const HISTORY_TEXT_MAX = 64_000

export interface MergeSegment {
  kind: 'thinking' | 'text' | 'media'
  text: string
  startedAt?: number
  chars?: number
  meta?: string
  mediaType?: 'image' | 'video' | 'audio' | 'file'
  path?: string
  name?: string
  size?: number
  mime?: string
  state?: 'ok' | 'missing'
  localUri?: string
}

export interface MergeCommandMeta {
  name: string
  variant?: string
  suggestion?: string
  hint?: string
}

export interface MergeMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  segments?: MergeSegment[]
  ts: number
  streaming?: boolean
  status?: 'ok' | 'failed' | 'unconfirmed'
  error?: string
  cmd?: MergeCommandMeta
}

export interface ServerInflightTurn {
  user?: string
  assistant?: string
  streaming?: boolean
  corrections?: string[]
  error?: string
  status?: string
}

function segmentsForMessage(m: MergeMessage): MergeSegment[] {
  if (m.segments?.length) return m.segments.map((s) => ({ ...s }))
  return m.text ? [{ kind: 'text', text: m.text }] : []
}

function mergeTwoAssistantMessages(first: MergeMessage, next: MergeMessage): MergeMessage {
  const segs: MergeSegment[] = []
  for (const src of [first, next]) {
    for (const seg of segmentsForMessage(src)) {
      if (seg.kind === 'media') {
        segs.push(seg)
        continue
      }
      const trimmed = seg.text
      if (!trimmed.trim()) continue
      const last = segs[segs.length - 1]
      if (last && last.kind === seg.kind) {
        const joined = seg.kind === 'text' ? `${last.text}\n${trimmed}` : `${last.text}${trimmed}`
        segs[segs.length - 1] = {
          ...last,
          text: joined.slice(0, HISTORY_TEXT_MAX),
          ...(seg.kind === 'thinking'
            ? { chars: (last.chars ?? last.text.length) + (seg.chars ?? trimmed.length) }
            : {}),
        }
      } else {
        segs.push({ ...seg, text: trimmed.slice(0, HISTORY_TEXT_MAX) })
      }
    }
  }
  const text = segs
    .filter((s) => s.kind === 'text')
    .map((s) => s.text)
    .join('\n')
    .slice(0, HISTORY_TEXT_MAX)
  return {
    ...first,
    text,
    ...(segs.length ? { segments: segs } : {}),
    streaming: !!(first.streaming || next.streaming),
    ...(next.status ? { status: next.status } : first.status ? { status: first.status } : {}),
    ...(next.error ? { error: next.error } : first.error ? { error: first.error } : {}),
    ...(next.cmd && !first.cmd ? { cmd: next.cmd } : {}),
  }
}

/** Group consecutive non-command assistant rows between user rows into ONE
 *  assistant message with ordered segments, preventing long multi-step /
 *  multi-part responses from breaking into multiple bubbles on reload. */
export function groupConsecutiveAssistantMessages(rows: MergeMessage[]): MergeMessage[] {
  const out: MergeMessage[] = []
  for (const row of rows) {
    const prev = out[out.length - 1]
    if (row.role === 'assistant' && !row.cmd && prev && prev.role === 'assistant' && !prev.cmd) {
      out[out.length - 1] = mergeTwoAssistantMessages(prev, row)
    } else {
      out.push(row)
    }
  }
  return out
}

function normUserText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function findMatchingUserIndex(list: MergeMessage[], targetText: string, occurrenceFromEnd = 1): number {
  const want = normUserText(targetText)
  if (!want) return -1
  let seen = 0
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role !== 'user') continue
    if (normUserText(list[i].text) === want) {
      seen++
      if (seen === occurrenceFromEnd) return i
    }
  }
  return -1
}

function countOccurrences(list: MergeMessage[], targetText: string): number {
  const want = normUserText(targetText)
  if (!want) return 0
  let n = 0
  for (const m of list) {
    if (m.role === 'user' && normUserText(m.text) === want) n++
  }
  return n
}

/**
 * Reconcile server history rows + optional `inflight` snapshot with existing
 * local `prevMessages` so mid-turn switches NEVER lose sent user messages,
 * failed/unconfirmed messages, local command cards, or live streaming tails.
 */
export function reconcileHistoryMessages(
  serverMapped: MergeMessage[],
  prevMessages: MergeMessage[],
  opts: {
    inflight?: ServerInflightTurn | null
    makeId: () => string
    now?: number
  },
): MergeMessage[] {
  const now = opts.now ?? Date.now()
  let merged = groupConsecutiveAssistantMessages(serverMapped.map((m) => ({ ...m })))

  // 1. Fold gateway `inflight` turn snapshot if the server hasn't flushed it
  //    into `res.messages` yet.
  const inf = opts.inflight
  if (inf) {
    const infUser = typeof inf.user === 'string' ? inf.user.trim() : ''
    const lastServerUserIdx = (() => {
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i].role === 'user') return i
      }
      return -1
    })()
    const lastServerUserText = lastServerUserIdx >= 0 ? normUserText(merged[lastServerUserIdx].text) : ''
    const hasInfUser = !!(infUser && lastServerUserText === normUserText(infUser))
    if (infUser && !hasInfUser) {
      merged.push({
        id: opts.makeId(),
        role: 'user',
        text: infUser.slice(0, HISTORY_TEXT_MAX),
        ts: now,
      })
    }
    for (const corr of inf.corrections ?? []) {
      const c = typeof corr === 'string' ? corr.trim() : ''
      if (!c) continue
      const tailUser = (() => {
        for (let i = merged.length - 1; i >= 0; i--) {
          if (merged[i].role === 'user') return merged[i].text
        }
        return ''
      })()
      if (normUserText(tailUser) !== normUserText(c)) {
        merged.push({ id: opts.makeId(), role: 'user', text: c.slice(0, HISTORY_TEXT_MAX), ts: now })
      }
    }
    const infAssistant = typeof inf.assistant === 'string' ? inf.assistant : ''
    const infFailed = inf.status === 'error' || !!inf.error
    const infError = typeof inf.error === 'string' && inf.error ? inf.error : undefined
    if (infAssistant || inf.streaming || infFailed) {
      const last = merged[merged.length - 1]
      if (last?.role === 'assistant' && !last.cmd && merged.length - 1 > lastServerUserIdx) {
        merged[merged.length - 1] = {
          ...last,
          ...(infAssistant && infAssistant.length >= last.text.length ? { text: infAssistant.slice(0, HISTORY_TEXT_MAX) } : {}),
          streaming: !!inf.streaming,
          ...(infFailed ? { status: 'failed' as const, error: infError ?? 'Turn failed' } : {}),
        }
      } else {
        merged.push({
          id: opts.makeId(),
          role: 'assistant',
          text: infAssistant.slice(0, HISTORY_TEXT_MAX),
          ts: now,
          ...(inf.streaming ? { streaming: true } : {}),
          ...(infFailed ? { status: 'failed' as const, error: infError ?? 'Turn failed' } : {}),
        })
      }
    }
  }

  if (!merged.length) {
    return prevMessages.length ? [...prevMessages] : []
  }
  if (!prevMessages.length) {
    return merged
  }

  // 2. Preserve local unpersisted turns after the last user message that
  //    server history already reflects.
  const serverLastUserIdx = (() => {
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].role === 'user') return i
    }
    return -1
  })()

  if (serverLastUserIdx < 0) {
    // Server has no user message at all (rare) — keep any local user turns +
    // following messages if the local transcript already started a conversation.
    const firstLocalUserIdx = prevMessages.findIndex((m) => m.role === 'user')
    if (firstLocalUserIdx >= 0) {
      return [...merged, ...prevMessages.slice(firstLocalUserIdx)]
    }
  } else {
    const serverLastUserText = merged[serverLastUserIdx].text
    const serverCount = countOccurrences(merged, serverLastUserText)
    const localCount = countOccurrences(prevMessages, serverLastUserText)
    const occFromEnd = localCount >= serverCount ? localCount - serverCount + 1 : 1
    const localMatchIdx = findMatchingUserIndex(prevMessages, serverLastUserText, occFromEnd)

    if (localMatchIdx >= 0) {
      const localAfter = prevMessages.slice(localMatchIdx + 1)
      const firstExtraUserInLocal = localAfter.findIndex((m) => m.role === 'user')
      const localCmdsBeforeExtraUser = (
        firstExtraUserInLocal >= 0 ? localAfter.slice(0, firstExtraUserInLocal) : localAfter
      ).filter((m) => !!m.cmd)

      // Preserve any live/streaming assistant tail for that SAME last user turn
      // when the server hasn't committed an assistant answer (or only partial).
      const streamingIdx = (() => {
        const bound = firstExtraUserInLocal >= 0 ? firstExtraUserInLocal : localAfter.length
        for (let i = bound - 1; i >= 0; i--) {
          if (localAfter[i].role === 'assistant' && localAfter[i].streaming) return i
        }
        return -1
      })()
      if (streamingIdx >= 0) {
        const tail = localAfter[streamingIdx]
        const last = merged[merged.length - 1]
        const serverHasAnswerForLastTurn = merged.length - 1 > serverLastUserIdx && last?.role === 'assistant'
        const cont =
          serverHasAnswerForLastTurn &&
          last.text.length > 0 &&
          (tail.text.startsWith(last.text) || last.text.startsWith(tail.text))
        if (cont) {
          merged[merged.length - 1] = {
            ...last,
            ...(tail.text.length > last.text.length ? { text: tail.text, segments: tail.segments } : { segments: last.segments?.length ? last.segments : tail.segments }),
            streaming: true,
          }
        } else if (!serverHasAnswerForLastTurn || tail.text.length > last.text.length) {
          if (serverHasAnswerForLastTurn) {
            merged[merged.length - 1] = {
              ...tail,
              segments: tail.segments?.length ? tail.segments : last.segments,
              streaming: true,
            }
          } else {
            merged.push(tail)
          }
        }
      }

      if (localCmdsBeforeExtraUser.length) {
        merged.push(...localCmdsBeforeExtraUser)
      }
      if (firstExtraUserInLocal >= 0) {
        merged.push(...localAfter.slice(firstExtraUserInLocal))
      }
      return groupConsecutiveAssistantMessages(merged)
    } else {
      // Server's latest user message wasn't in local history (e.g. from another
      // device), OR local user sent prompts before server committed anything.
      // Preserve any trailing local user turns whose text isn't in `merged` at all
      // (plus their assistant/cmd rows after them), e.g., failed/unconfirmed
      // local sends or in-flight local sends.
      const unpersistedStart = (() => {
        for (let i = prevMessages.length - 1; i >= 0; i--) {
          const m = prevMessages[i]
          if (m.role !== 'user') continue
          const matchedInServer =
            !m.status || m.status === 'ok'
              ? findMatchingUserIndex(merged, m.text, 1) >= 0
              : false
          if (matchedInServer) return i + 1
        }
        // Only treat the whole local tail as unpersisted if the last local user
        // turn itself looks freshly sent (local failure/unconfirmed) or no server
        // overlap existed; otherwise avoid duplicating an ancient transcript.
        const lastLocalUser = [...prevMessages].reverse().find((m) => m.role === 'user')
        if (lastLocalUser && (lastLocalUser.status === 'failed' || lastLocalUser.status === 'unconfirmed')) {
          const idx = prevMessages.lastIndexOf(lastLocalUser)
          return idx
        }
        return -1
      })()
      if (unpersistedStart >= 0 && unpersistedStart < prevMessages.length) {
        const extra = prevMessages.slice(unpersistedStart)
        if (extra.some((m) => m.role === 'user')) {
          merged = [...merged, ...extra]
        }
      }
    }
  }

  return groupConsecutiveAssistantMessages(merged)
}
