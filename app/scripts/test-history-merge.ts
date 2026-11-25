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

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
