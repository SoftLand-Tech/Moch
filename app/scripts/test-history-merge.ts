// Unit tests for history merging and mid-turn sent-message preservation.
// Run: cd app && npx tsx scripts/test-history-merge.ts

import {
  groupConsecutiveAssistantMessages,
  reconcileHistoryMessages,
  type MergeMessage,
} from '../src/lib/historyMerge'

let pass = 0
let fail = 0
let seq = 1
const makeId = () => `id-${seq++}`
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const msg = (
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<MergeMessage> = {},
): MergeMessage => ({
  id: makeId(),
  role,
  text,
  ts: 1000,
  ...extra,
})

function main() {
  // ── 1. Long / multi-step assistant replies stay ONE bubble ──────────────
  const longPart1 = 'A'.repeat(12_000)
  const longPart2 = 'B'.repeat(12_000)
  const grouped = groupConsecutiveAssistantMessages([
    msg('user', 'explain everything'),
    msg('assistant', longPart1, {
      segments: [
        { kind: 'thinking', text: 'step 1 thought', startedAt: 1000 },
        { kind: 'text', text: longPart1 },
      ],
    }),
    msg('assistant', longPart2, {
      segments: [
        { kind: 'thinking', text: 'step 2 thought', startedAt: 1050 },
        { kind: 'text', text: longPart2 },
      ],
    }),
  ])
  check(
    'consecutive assistant step rows merge into one bubble',
    grouped.length === 2 && grouped[1].role === 'assistant',
    `len=${grouped.length}`,
  )
  check(
    'merged long assistant keeps full 24k text without 8k slicing or splitting',
    grouped[1]?.text === `${longPart1}\n${longPart2}` && grouped[1]?.text.length === 24_001,
    `len=${grouped[1]?.text.length}`,
  )
  check(
    'merged assistant preserves segment order (thinking,text,thinking,text)',
    grouped[1]?.segments?.map((s) => s.kind).join(',') === 'thinking,text,thinking,text',
    JSON.stringify(grouped[1]?.segments?.map((s) => s.kind)),
  )

  // ── 2. Command cards are NOT merged with prose ───────────────────────────
  const withCmd = groupConsecutiveAssistantMessages([
    msg('assistant', 'prose'),
    msg('assistant', '/status output', { cmd: { name: 'status' } }),
  ])
  check('command card stays separate from assistant prose', withCmd.length === 2)

  // ── 3. Leaving mid-turn before server flushes sent user message ──────────
  const serverPriorOnly: MergeMessage[] = [
    msg('user', 'first prompt'),
    msg('assistant', 'first answer'),
  ]
  const localMidTurn: MergeMessage[] = [
    msg('user', 'first prompt'),
    msg('assistant', 'first answer'),
    msg('user', 'second prompt sent mid-turn'),
    msg('assistant', 'partial answer...', { streaming: true }),
  ]
  const rec1 = reconcileHistoryMessages(serverPriorOnly, localMidTurn, { makeId })
  check(
    'mid-turn switch preserves unpersisted user message + streaming reply',
    rec1.length === 4 &&
      rec1[2].role === 'user' &&
      rec1[2].text === 'second prompt sent mid-turn' &&
      rec1[3].role === 'assistant' &&
      rec1[3].streaming === true &&
      rec1[3].text === 'partial answer...',
    JSON.stringify(rec1.map((m) => [m.role, m.text, !!m.streaming])),
  )

  // ── 4. User message sent, no assistant delta yet ─────────────────────────
  const localUserOnlyPending: MergeMessage[] = [
    msg('user', 'first prompt'),
    msg('assistant', 'first answer'),
    msg('user', 'waiting on first token'),
  ]
  const rec2 = reconcileHistoryMessages(serverPriorOnly, localUserOnlyPending, { makeId })
  check(
    'preserves sent user message even before assistant starts streaming',
    rec2.length === 3 && rec2[2].role === 'user' && rec2[2].text === 'waiting on first token',
    JSON.stringify(rec2.map((m) => [m.role, m.text])),
  )

  // ── 5. Brand-new chat: user sent turn 1, server returns empty + inflight ─
  const rec3 = reconcileHistoryMessages([], [msg('user', 'turn one prompt')], {
    inflight: { user: 'turn one prompt', assistant: 'working on it', streaming: true },
    makeId,
  })
  check(
    'empty server messages + inflight snapshot preserves local/inflight turn',
    rec3.length >= 1 && rec3[0].role === 'user' && rec3[0].text === 'turn one prompt',
    JSON.stringify(rec3.map((m) => [m.role, m.text])),
  )

  // ── 6. Server returns inflight turn not yet in res.messages ──────────────
  const rec4 = reconcileHistoryMessages(serverPriorOnly, [], {
    inflight: { user: 'cold resumed prompt', assistant: 'in progress', streaming: true },
    makeId,
  })
  check(
    'cold resume folds res.inflight user + streaming assistant',
    rec4.length === 4 &&
      rec4[2].role === 'user' &&
      rec4[2].text === 'cold resumed prompt' &&
      rec4[3].role === 'assistant' &&
      rec4[3].text === 'in progress' &&
      rec4[3].streaming === true,
    JSON.stringify(rec4.map((m) => [m.role, m.text, !!m.streaming])),
  )

  // ── 7. Repeated identical prompt text does not drop newer turn ───────────
  const rec5 = reconcileHistoryMessages(
    [msg('user', 'ok'), msg('assistant', 'done 1')],
    [msg('user', 'ok'), msg('assistant', 'done 1'), msg('user', 'ok')],
    { makeId },
  )
  check(
    'repeated identical prompt text keeps second unpersisted ok',
    rec5.length === 3 && rec5[2].role === 'user' && rec5[2].text === 'ok',
    JSON.stringify(rec5.map((m) => [m.role, m.text])),
  )

  // ── 8. Hydration keeps local user media and caption ───────────────────────
  const localAttached = msg('user', 'What is this?', {
    segments: [
      { kind: 'text', text: 'What is this?' },
      { kind: 'media', text: '', mediaType: 'image', path: '/cache/shot.png', name: 'shot.png' },
    ],
  })
  const recAttached = reconcileHistoryMessages(
    [msg('user', 'What is this?'), msg('assistant', 'A screenshot.')],
    [localAttached],
    { makeId },
  )
  check(
    'matched server user row keeps local attachment segments and id',
    recAttached.length === 2 && recAttached[0].id === localAttached.id &&
      !!recAttached[0].segments?.some((s) => s.kind === 'media') &&
      recAttached[0].text === 'What is this?',
  )

  // ── 9. OpenCode prompt refs do not create a duplicate turn ─────────────────
  const recRefs = reconcileHistoryMessages(
    [msg('user', 'Inspect this\n@file:/relay/shot.png'), msg('assistant', 'done')],
    [msg('user', 'Inspect this'), msg('assistant', 'one')],
    { makeId },
  )
  check(
    'appended @file refs match the local caption without duplicating the assistant turn',
    recRefs.length === 2 && recRefs[0].role === 'user' && recRefs[0].text === 'Inspect this' &&
      recRefs[1].role === 'assistant' && recRefs[1].text === 'done',
    JSON.stringify(recRefs.map((m) => [m.role, m.text])),
  )

  // ── 10. A userless server page cannot be aligned safely ───────────────────
  const localHistory = [msg('user', 'old prompt'), msg('assistant', 'old answer')]
  const recNoUser = reconcileHistoryMessages([msg('assistant', 'new answer')], localHistory, { makeId })
  check(
    'userless server page preserves local history instead of duplicating it',
    recNoUser.length === localHistory.length && recNoUser[0].text === 'old prompt' && recNoUser[1].text === 'old answer',
  )

  // ── 11. Shared prefixes do not cross-match different prompts ─────────────
  const newerAttached = msg('user', 'Check', {
    ts: 2000,
    segments: [
      { kind: 'text', text: 'Check' },
      { kind: 'media', text: '', mediaType: 'image', path: '/cache/shot.png', name: 'shot.png' },
    ],
  })
  const recPrefix = reconcileHistoryMessages(
    [msg('user', 'Check\n@file:/relay/shot.png', { ts: 2000 }), msg('assistant', 'new answer')],
    [msg('user', 'Check this document', { ts: 1000 }), msg('assistant', 'old answer', { ts: 1500 }), newerAttached, msg('assistant', 'new answer', { ts: 3000 })],
    { makeId },
  )
  check(
    'shared prompt prefix does not attach the newer answer to the older turn',
    recPrefix.length === 2 && recPrefix[0].id === newerAttached.id &&
      !!recPrefix[0].segments?.some((s) => s.kind === 'media') && recPrefix[1].text === 'new answer',
    JSON.stringify(recPrefix.map((m) => [m.role, m.text])),
  )

  // ── 12. Repeated prompts match the correct assistant turn ────────────────
  const repeatedLocal = [
    msg('user', 'ok', { ts: 1000 }), msg('assistant', 'done 1', { ts: 1500 }),
    msg('user', 'ok', { ts: 2000 }), msg('assistant', 'done 2', { ts: 2500 }),
  ]
  const recRepeated = reconcileHistoryMessages(
    [msg('user', 'ok', { ts: 2000 }), msg('assistant', 'done 2', { ts: 2500 })],
    repeatedLocal,
    { makeId },
  )
  check(
    'repeated identical prompts match the newest assistant instead of duplicating it',
    recRepeated.length === 2 && recRepeated[0].id === repeatedLocal[2].id && recRepeated[1].text === 'done 2',
    JSON.stringify(recRepeated.map((m) => [m.role, m.text])),
  )

  // ── 13. Empty-caption attachment rows survive forced hydration ───────────
  const emptyAttached = msg('user', '', {
    segments: [{ kind: 'media', text: '', mediaType: 'file', path: '/cache/a.pdf', name: 'a.pdf' }],
  })
  const recEmptyAttached = reconcileHistoryMessages(
    [msg('user', '@file:/relay/a.pdf'), msg('assistant', 'read it')],
    [emptyAttached],
    { makeId },
  )
  check(
    'empty-caption local attachment matches refs-only server prompt and keeps its tile',
    recEmptyAttached.length === 2 && recEmptyAttached[0].id === emptyAttached.id &&
      !!recEmptyAttached[0].segments?.some((s) => s.kind === 'media'),
  )

  // ── 14. Prompt-budget truncation keeps local attachment media ────────────
  const longCaption = 'x'.repeat(8_000)
  const longAttached = msg('user', longCaption, {
    ts: 5_000,
    segments: [
      { kind: 'text', text: longCaption },
      { kind: 'media', text: '', mediaType: 'image', path: '/cache/shot.png', name: 'shot.png' },
    ],
  })
  const recLongAttached = reconcileHistoryMessages(
    [msg('user', `${'x'.repeat(7_979)}\n@file:/relay/shot.png`, { ts: 15_000 }), msg('assistant', 'seen')],
    [longAttached],
    { makeId },
  )
  check(
    'budget-truncated attachment caption still preserves the local tile',
    recLongAttached.length === 2 && recLongAttached[0].id === longAttached.id &&
      !!recLongAttached[0].segments?.some((s) => s.kind === 'media'),
  )

  const slowImage = msg('user', 'Slow image', {
    ts: 1_000,
    segments: [
      { kind: 'text', text: 'Slow image' },
      { kind: 'media', text: '', mediaType: 'image', path: '/cache/slow.png', name: 'slow.png' },
    ],
  })
  const recSlowImage = reconcileHistoryMessages(
    [msg('user', 'Slow image', { ts: 301_000 }), msg('assistant', 'seen')],
    [slowImage],
    { makeId },
  )
  check(
    'captioned image without file refs keeps local media after a slow upload',
    recSlowImage.length === 2 && recSlowImage[0].id === slowImage.id &&
      !!recSlowImage[0].segments?.some((s) => s.kind === 'media'),
  )

  // ── 15. Completed local answer survives server persistence lag ───────────
  const recCompletedTail = reconcileHistoryMessages(
    [msg('user', 'latest prompt')],
    [msg('user', 'latest prompt'), msg('assistant', 'finished answer', { status: 'ok' })],
    { makeId },
  )
  check(
    'completed local assistant is kept until server history persists its answer',
    recCompletedTail.length === 2 && recCompletedTail[1].role === 'assistant' &&
      recCompletedTail[1].text === 'finished answer' && !recCompletedTail[1].streaming,
  )

  const recOldCompleted = reconcileHistoryMessages(
    [msg('user', 'ok', { ts: 10_000 })],
    [msg('user', 'ok', { ts: 1_000 }), msg('assistant', 'old completed answer', { ts: 9_500 })],
    { makeId },
  )
  check(
    'completed answer from an older identical prompt is not attached to a newer turn',
    recOldCompleted.length === 1 && recOldCompleted[0].role === 'user',
  )

  const recLongerCompleted = reconcileHistoryMessages(
    [msg('user', 'latest', { ts: 1_000 }), msg('assistant', 'partial', { ts: 1_500 })],
    [msg('user', 'latest', { ts: 1_000 }), msg('assistant', 'complete answer', { ts: 2_000, status: 'ok' })],
    { makeId },
  )
  check(
    'longer completed local answer replaces a partial server answer for the same turn',
    recLongerCompleted.length === 2 && recLongerCompleted[1].text === 'complete answer',
  )

  const recInflightTail = reconcileHistoryMessages(
    [msg('user', 'prior', { ts: 50 }), msg('assistant', 'done', { ts: 75 })],
    [
      msg('user', 'prior', { ts: 50 }), msg('assistant', 'done', { ts: 75 }),
      msg('user', 'current', { ts: 100, segments: [{ kind: 'text', text: 'current' }, { kind: 'media', text: '', mediaType: 'image', path: '/cache/a.png', name: 'a.png' }] }),
      msg('assistant', 'longer local streaming answer', { ts: 200, streaming: true }),
    ],
    { inflight: { user: 'current', assistant: 'short snapshot', streaming: true }, now: 1_000, makeId },
  )
  check(
    'inflight snapshot keeps the matching local user media and longer streaming tail',
    recInflightTail.length === 4 && recInflightTail[2].text === 'current' &&
      !!recInflightTail[2].segments?.some((s) => s.kind === 'media') &&
      recInflightTail[3].text === 'longer local streaming answer' && !!recInflightTail[3].streaming,
  )

  const recRepeatedInflight = reconcileHistoryMessages(
    [msg('user', 'unrelated', { ts: 50 }), msg('assistant', 'prior', { ts: 75 })],
    [msg('user', 'same', { ts: 100 }), msg('assistant', 'old completed answer', { ts: 200 })],
    { inflight: { user: 'same', assistant: 'new snapshot', streaming: true, started_at: 10 }, now: 10_000, makeId },
  )
  check(
    'repeated inflight prompt does not inherit an older completed local turn',
    recRepeatedInflight.length === 4 && recRepeatedInflight[2].ts === 10_000 &&
      recRepeatedInflight[3].text === 'new snapshot',
  )

  const recRepeatedServerInflight = reconcileHistoryMessages(
    [msg('user', 'same', { ts: 100 }), msg('assistant', 'old completed answer', { ts: 200 })],
    [],
    { inflight: { user: 'same', assistant: 'new snapshot', streaming: true, started_at: 10 }, now: 10_000, makeId },
  )
  check(
    'repeated inflight prompt adds a new boundary instead of mutating the previous server turn',
    recRepeatedServerInflight.length === 4 && recRepeatedServerInflight[2].role === 'user' &&
      recRepeatedServerInflight[3].text === 'new snapshot',
  )

  const recLongPending = reconcileHistoryMessages(
    [msg('user', 'long pending turn', { ts: 1_000 })],
    [],
    { inflight: { user: 'long pending turn', assistant: 'still working', streaming: true, started_at: 1 }, now: 2_760_000, makeId },
  )
  check(
    'pending server turn older than 45 minutes reuses its user boundary',
    recLongPending.length === 2 && recLongPending[0].role === 'user' &&
      recLongPending[1].text === 'still working',
  )

  const recFailedUserOnly = reconcileHistoryMessages(
    [msg('user', 'same', { ts: 100 })],
    [],
    { inflight: { user: 'same', assistant: 'new snapshot', streaming: true, started_at: 10 }, now: 10_000, makeId },
  )
  check(
    'failed user-only server turn does not adopt a later repeated inflight prompt',
    recFailedUserOnly.length === 3 && recFailedUserOnly.filter((m) => m.role === 'user').length === 2 &&
      recFailedUserOnly[2].text === 'new snapshot',
  )

  const epochSec = 1_700_000_000
  const recEpochPending = reconcileHistoryMessages(
    [msg('user', 'epoch pending', { ts: epochSec * 1000 })],
    [],
    { inflight: { user: 'epoch pending', assistant: 'working', streaming: true, started_at: epochSec }, now: epochSec * 1000 + 60_000, makeId },
  )
  check(
    'real epoch seconds normalize to the same turn marker as millisecond history',
    recEpochPending.length === 2 && recEpochPending[0].role === 'user' && recEpochPending[1].text === 'working',
  )

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
