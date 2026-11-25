/**
 * Pure OpenCode-history mapping — NO React Native / AsyncStorage imports, so
 * `scripts/test-oc-history.ts` can exercise it under plain tsx.
 *
 * OpenCode persists ONE turn as several assistant messages (one per
 * model/tool step). Mapping them 1:1 made rehydration render N bubbles where
 * the live stream (`ocHooksFor.start` once per turn) showed one. This mapper
 * groups consecutive assistant messages between two user messages into one
 * turn row and keeps every block's order in `segments`.
 */

export interface OcHistorySegment {
  kind: 'thinking' | 'text'
  text: string
}

export interface OcHistoryCursorPage {
  cursor?: { previous?: string; next?: string }
}

/** Cursor requests must not resend `order`; OpenCode 2.3.0 rejects that. */
export function ocHistoryPageQuery(cursor: string | undefined, pageSize: number): string {
  const query = [`limit=${pageSize}`]
  if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`)
  else query.push('order=desc')
  return query.join('&')
}

/** In newest-first order, `next` walks toward older messages. */
export function nextOcHistoryCursor(page: OcHistoryCursorPage): string | undefined {
  return page.cursor?.next
}

export interface OcHistoryRow {
  role: 'user' | 'assistant'
  text: string
  ts: number
  /** Server-side attachment names for user rows; local tiles are merged separately. */
  attachmentNames?: string[]
  /** Tool rows the UI may render (name + one-line status). */
  tools?: Array<{ id: string; name: string; ok: boolean }>
  thinking?: string
  /** Assistant turns only: thinking/text blocks in stream order, merged
   *  across the step messages of the same turn. `text`/`thinking` stay the
   *  joined copies for older readers. */
  segments?: OcHistorySegment[]
}

/**
 * Structural slice of the server's message payload. `opencodeClient` owns the
 * full wire type; this module stays dependency-free but structurally accepts
 * it (extra `state` keys are fine).
 */
export interface OcHistoryMessageLike {
  type: 'user' | 'assistant' | 'idle' | string
  time?: { created?: number | string }
  /** OpenCode 2.3.0 `SessionMessage.User` top-level prompt text. */
  text?: string
  /** Legacy/fallback prompt container. */
  payload?: { text?: string }
  files?: Array<{ name?: string; filename?: string; mime?: string }>
  content?: Array<{
    type: 'text' | 'reasoning' | 'tool' | string
    text?: string
    id?: string
    name?: string
    state?: { status?: string }
  }>
}

function parseOcTs(created: number | string | undefined, fallback: number): number {
  if (typeof created === 'number' && Number.isFinite(created)) return created
  if (typeof created === 'string' && created.trim()) {
    const parsed = Date.parse(created)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function extractOcAttachmentNames(m: OcHistoryMessageLike): string[] {
  if (!Array.isArray(m.files)) return []
  return m.files
    .map((f) =>
      typeof f?.name === 'string' ? f.name.trim() : typeof f?.filename === 'string' ? f.filename.trim() : '',
    )
    .filter(Boolean)
}

function extractOcUserText(m: OcHistoryMessageLike): string {
  const raw = typeof m.text === 'string' ? m.text : typeof m.payload?.text === 'string' ? m.payload.text : ''
  const trimmed = raw.trim()
  if (trimmed) return trimmed
  return extractOcAttachmentNames(m).length ? '[attachment]' : ''
}

function normPromptText(text: string): string {
  const lines = text.split('\n')
  while (lines.length && /^\s*@file:/.test(lines[lines.length - 1])) lines.pop()
  return lines.join('\n').trim().replace(/\s+/g, ' ')
}

/** Return only the assistant row owned by the supplied user prompt. A newest
 *  assistant from an earlier turn must never be copied into an empty new turn. */
export function findOcTurnAssistant(
  rows: OcHistoryRow[],
  prompt: string,
  sinceMs?: number,
): OcHistoryRow | undefined {
  const want = normPromptText(prompt)
  const minTs = sinceMs === undefined ? -Infinity : sinceMs - 1_000
  let userIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.role !== 'user' || row.ts < minTs) continue
    const got = row.text === '[attachment]' ? '' : normPromptText(row.text)
    if (want === got) {
      userIdx = i
      break
    }
  }
  // Command templates expand before persistence, so their durable user text
  // differs from the raw arguments. Fall back to the user row created by this
  // turn's time boundary, never to an older identical prompt.
  if (userIdx < 0 && sinceMs !== undefined) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user' && rows[i].ts >= minTs) {
        userIdx = i
        break
      }
    }
  }
  if (userIdx < 0) return undefined
  for (let i = rows.length - 1; i > userIdx; i--) {
    if (rows[i].role === 'assistant') return rows[i]
  }
  return undefined
}

/** Map GET /api/session/:id/message (NEWEST FIRST) into chat rows, oldest
 *  first, with one assistant row per turn. */
export function mapOcHistory(messages: OcHistoryMessageLike[]): OcHistoryRow[] {
  const rows: OcHistoryRow[] = []
  // The assistant turn currently being collected; a user message flushes it.
  let turn: (OcHistoryRow & { segments: OcHistorySegment[]; tools: NonNullable<OcHistoryRow['tools']> }) | null = null

  const flush = () => {
    if (!turn) return
    // Trim each block, drop empties, and merge adjacent same-kind blocks
    // (text with a newline like the old per-part join; thinking direct like
    // the stream's delta concatenation).
    const segs: OcHistorySegment[] = []
    for (const seg of turn.segments) {
      const text = seg.text.trim()
      if (!text) continue
      const last = segs[segs.length - 1]
      if (last && last.kind === seg.kind) {
        last.text += seg.kind === 'text' ? `\n${text}` : text
      } else {
        segs.push({ kind: seg.kind, text })
      }
    }
    const text = segs.filter((s) => s.kind === 'text').map((s) => s.text).join('\n')
    const thinking = segs.filter((s) => s.kind === 'thinking').map((s) => s.text).join('')
    const tools = turn.tools
    if (text || thinking || tools.length) {
      rows.push({
        role: 'assistant',
        text,
        ts: turn.ts,
        tools,
        ...(thinking ? { thinking } : {}),
        ...(segs.length ? { segments: segs } : {}),
      })
    }
    turn = null
  }

  for (const m of [...(messages ?? [])].reverse()) {
    const createdTs = parseOcTs(m.time?.created, Date.now())
    if (m.type === 'user') {
      // A user message always starts a new turn — never merge across it,
      // even when its text is empty (it still separates persisted turns).
      flush()
      const text = extractOcUserText(m)
      if (text) {
        const attachmentNames = extractOcAttachmentNames(m)
        rows.push({
          role: 'user',
          text,
          ts: createdTs,
          ...(attachmentNames.length ? { attachmentNames } : {}),
        })
      }
      continue
    }
    if (m.type !== 'assistant') continue
    const parts: OcHistorySegment[] = []
    const tools: Array<{ id: string; name: string; ok: boolean }> = []
    for (const part of m.content ?? []) {
      if (part.type === 'text' && part.text) parts.push({ kind: 'text', text: part.text })
      else if (part.type === 'reasoning' && part.text) parts.push({ kind: 'thinking', text: part.text })
      else if (part.type === 'tool' && part.name) {
        const st = String(part.state?.status ?? 'done')
        tools.push({ id: String(part.id ?? part.name), name: part.name, ok: st !== 'error' })
      }
    }
    if (!parts.length && !tools.length) {
      // An empty assistant message is a step boundary, not content: it may
      // still OWN the turn's first timestamp, but never creates a row alone.
      if (!turn && m.time?.created != null) {
        turn = { role: 'assistant', text: '', ts: createdTs, tools: [], segments: [] }
      }
      continue
    }
    if (!turn) {
      // First step of the turn owns the row's timestamp.
      turn = { role: 'assistant', text: '', ts: createdTs, tools: [], segments: [] }
    }
    turn.segments.push(...parts)
    turn.tools.push(...tools)
  }
  flush()
  return rows
}
