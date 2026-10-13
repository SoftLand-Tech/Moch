// Unit tests for the busy-queue layer (no gateway, no RN): messages sent
// while a turn was running queue per chat, oldest first, capped, persisted.
//
// AsyncStorage cannot load in plain node, so a fake is injected before the
// module ever persists — the same pattern test-attention.ts uses.
type QueueMod = typeof import('../src/lib/sendQueue')
type RetryMod = typeof import('../src/lib/rpcRetry')

let q: QueueMod

// In-memory AsyncStorage stand-in.
const backing = new Map<string, string>()
const fakeStorage = {
  getItem: async (k: string) => backing.get(k) ?? null,
  setItem: async (k: string, v: string) => void backing.set(k, v),
}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

async function main() {
  q = await import('../src/lib/sendQueue')
  q._useStorageForTests(fakeStorage)
  const rr = await import('../src/lib/rpcRetry')
  const { GatewayTimeoutError } = await import('../src/protocol/json-rpc-channel')

  // ── Basic queue semantics ────────────────────────────────────────────────
  check('empty chat queues to []', q.queueFor('a').length === 0)
  check('queueFor with no id is []', q.queueFor(null).length === 0 && q.queueFor(undefined).length === 0)

  const m1 = q.enqueueSend('a', 'next question')
  check('enqueue stores the message', m1 != null && q.queueFor('a').length === 1 && q.queueFor('a')[0].text === 'next question')

  q.enqueueSend('a', 'and another')
  const listA = q.queueFor('a')
  check('messages queue oldest-first', listA.length === 2 && listA[0].text === 'next question' && listA[1].text === 'and another')

  check('chats queue independently', q.enqueueSend('b', 'other chat') != null && q.queueFor('b')[0].text === 'other chat' && q.queueFor('a').length === 2)

  check('enqueue trims and skips empty', q.enqueueSend('a', '   ') === null && q.queueFor('a').length === 2)
  const long = q.enqueueSend('a', 'x'.repeat(9000))
  check('enqueue caps text at 8000 chars', long != null && long.text.length === 8000)
  check('queued ids are unique', new Set(q.queueFor('a').map((x) => x.id)).size === 3)

  // ── Peek / remove / clear ───────────────────────────────────────────────
  check('peek returns the head without removing', q.peekQueued('a')?.text === 'next question' && q.queueFor('a').length === 3)
  check('peek on an empty chat is null', q.peekQueued('nope') === null)

  const head = q.peekQueued('a')!
  q.removeQueued('a', head.id)
  check('removeQueued drops one by id', q.queueFor('a').length === 2 && q.peekQueued('a')?.text === 'and another')
  q.removeQueued('a', 'nonexistent')
  check('removeQueued with unknown id is a no-op', q.queueFor('a').length === 2)

  q.clearSendQueue('a')
  check('clearSendQueue drops the whole chat only', q.queueFor('a').length === 0 && q.queueFor('b').length === 1)
  q.clearSendQueue('never-existed')
  check('clearSendQueue on an unknown chat is a no-op', true)

  // ── Persistence across restart ──────────────────────────────────────────
  q.sendQueue.set({})
  const p1 = q.enqueueSend('persist-me', 'survives a restart')
  q.enqueueSend('persist-me', 'second message')
  await q.flushSendQueue()
  q.sendQueue.set({})
  await q.loadSendQueue()
  const restored = q.queueFor('persist-me')
  check('queue persists across restart, order kept', restored.length === 2 && restored[0].text === 'survives a restart' && restored[1].text === 'second message')

  // Corrupt storage must not crash the load path.
  await fakeStorage.setItem('hermes.sendQueue.v1', '{not json')
  q.sendQueue.set({})
  await q.loadSendQueue()
  check('corrupt storage loads as empty', Object.keys(q.sendQueue.get()).length === 0)

  // Garbage entries are dropped, well-formed ones kept.
  await fakeStorage.setItem('hermes.sendQueue.v1', JSON.stringify({
    good: [{ id: 'g1', text: 'kept', ts: 123 }],
    bad: 'not-an-array',
    bad2: [{ noText: true }],
  }))
  q.sendQueue.set({})
  await q.loadSendQueue()
  check('load drops malformed entries, keeps valid ones', q.queueFor('good').length === 1 && q.queueFor('good')[0].id === 'g1' && q.queueFor('bad').length === 0 && q.queueFor('bad2').length === 0)

  // ── Caps ────────────────────────────────────────────────────────────────
  q.sendQueue.set({})
  let last: string | null = null
  for (let i = 0; i < 25; i++) {
    const r = q.enqueueSend('cap', `msg ${i}`)
    if (r) last = r.text
  }
  const capList = q.queueFor('cap')
  check('per-chat queue capped at 20', capList.length === 20, `got ${capList.length}`)
  check('cap keeps the oldest 20', capList[0].text === 'msg 0' && capList[19].text === 'msg 19')
  check('overflow enqueue returns null', last === 'msg 19')

  // Chat-count cap: at most 60 keys, oldest dropped.
  q.sendQueue.set({})
  for (let i = 0; i < 65; i++) q.enqueueSend(`chat-${i}`, `text ${i}`)
  const chatKeys = Object.keys(q.sendQueue.get())
  check('chat map capped at 60', chatKeys.length === 60, `got ${chatKeys.length}`)
  check('chat cap keeps newest chats', q.queueFor('chat-64').length === 1 && q.queueFor('chat-0').length === 0)

  // ── Auto-retry truth table (BUG-036 client half) ────────────────────────
  // The queue/outbox flushes must never re-fire a prompt.submit whose frame
  // was already sent when the 120s deadline hit — the turn may be running
  // remotely, and the server's own turn events re-release the queue.
  check(
    'resolve-phase timeout IS auto-retryable',
    rr.shouldAutoRetry('resolve', new GatewayTimeoutError('session.resume', 120)) === true,
  )
  check(
    'submit-phase timeout is NOT auto-retryable',
    rr.shouldAutoRetry('submit', new GatewayTimeoutError('prompt.submit', 120)) === false,
  )
  check(
    'submit-phase generic error IS auto-retryable',
    rr.shouldAutoRetry('submit', new Error('gateway not connected')) === true,
  )
  check(
    'resolve-phase generic error IS auto-retryable',
    rr.shouldAutoRetry('resolve', new Error('Not connected')) === true,
  )
  check(
    'an UnconfirmedSubmitError is never auto-retried (any phase)',
    rr.shouldAutoRetry('resolve', new rr.UnconfirmedSubmitError(new GatewayTimeoutError('prompt.submit', 120))) === false &&
      rr.shouldAutoRetry('submit', new rr.UnconfirmedSubmitError(new GatewayTimeoutError('prompt.submit', 120))) === false,
  )
  check(
    'classification is by type, not message text',
    rr.isGatewayTimeout(new Error('request timed out after 120s: prompt.submit')) === false,
  )
  check(
    'null/undefined/non-error values are not timeouts',
    rr.isGatewayTimeout(null) === false && rr.isGatewayTimeout(undefined) === false && rr.isGatewayTimeout('timeout') === false,
  )

  // ── Outbox pin policy (BH-000018) ───────────────────────────────────────
  // A pseudo `new:` stored id can never be matched to a live entry or
  // resumed, so pinning an offline-enqueued text to one strands it forever.
  check('outbox pin passes a real stored id through', rr.outboxPinFor('sess-123') === 'sess-123')
  check('outbox pin never pins to a pseudo new: id', rr.outboxPinFor('new:m1_2') === '')
  check(
    'outbox pin of undefined/empty is unpinned',
    rr.outboxPinFor(undefined) === '' && rr.outboxPinFor('') === '',
  )

  // ── Outbox origin routing (BH-000019) ───────────────────────────────────
  // An unpinned item composed in a provisional window carries the window's
  // temp id as originId: while the window is still tracked the flush routes
  // through IT (its own keyed create), never the flush-time active chat.
  const liveWindow = new Set(['pending:new:m1_1', 'live-a', 'live-b'])
  check(
    'alive origin window -> route through its id',
    JSON.stringify(rr.outboxTargetFor({ storedId: '', originId: 'pending:new:m1_1' }, liveWindow)) ===
      JSON.stringify({ kind: 'origin', id: 'pending:new:m1_1' }),
  )
  check(
    'swept origin window (newChat re-sweep) -> unpinned fallback',
    rr.outboxTargetFor({ storedId: '', originId: 'pending:new:gone' }, liveWindow).kind === 'active',
  )
  check(
    'swept origin window with a real pin -> pinned fallback',
    rr.outboxTargetFor({ storedId: 'sess-9', originId: 'pending:new:gone' }, liveWindow).kind === 'pinned',
  )
  check(
    'no origin (legacy item) -> today\'s behavior unchanged',
    rr.outboxTargetFor({ storedId: 'sess-9' }, liveWindow).kind === 'pinned' &&
      rr.outboxTargetFor({ storedId: '' }, liveWindow).kind === 'active',
  )
  check(
    'origin wins over a same-chat pin while tracked (freshest identity)',
    rr.outboxTargetFor({ storedId: 'sess-9', originId: 'live-a' }, liveWindow).kind === 'origin',
  )
  check(
    'a live non-provisional origin is a valid origin route',
    rr.outboxTargetFor({ storedId: '', originId: 'live-b' }, liveWindow).kind === 'origin',
  )

  // ── v1 transcript migration sweep (BH-000024) ───────────────────────────
  const tm = await import('../src/lib/transcriptMigrate')
  const v1 = (id: string) => `hermes.transcript.${id}.v1`
  const v2 = (id: string) => `hermes.transcript.${id}.v2`
  const migStore = new Map<string, string>()
  const migStorage = {
    getItem: async (k: string) => migStore.get(k) ?? null,
    setItem: async (k: string, val: string) => void migStore.set(k, val),
    removeItem: async (k: string) => void migStore.delete(k),
  }
  // Pure half: the live ids map to the stored id, newest first.
  const sidMap = { 'live-old': 'store-1', 'live-mid': 'store-2', 'live-new': 'store-1' }
  check(
    'legacyV1KeysFor returns the mapped live ids, newest first',
    JSON.stringify(tm.legacyV1KeysFor('store-1', sidMap)) === JSON.stringify(['live-new', 'live-old']),
  )
  check('legacyV1KeysFor for an unmapped stored id is []', tm.legacyV1KeysFor('store-x', sidMap).length === 0)

  // Interim v1 + live-keyed v1s both present: the interim payload wins AND
  // the legacy blobs are still swept (the old code returned early and
  // stranded them forever).
  migStore.clear()
  migStore.set(v1('store-1'), '{"v":1,"title":"interim","messages":[]}')
  migStore.set(v1('live-old'), '[{"old":true}]')
  migStore.set(v1('live-new'), '[{"new":true}]')
  const interimOut = await tm.migrateV1TranscriptWith(migStorage, 'store-1', { v1, v2 }, sidMap)
  check('interim branch returns the interim payload', interimOut === '{"v":1,"title":"interim","messages":[]}')
  check('interim branch writes v2', migStore.get(v2('store-1')) === '{"v":1,"title":"interim","messages":[]}')
  check('interim branch removes its own key', !migStore.has(v1('store-1')))
  check(
    'BH-000024: interim branch ALSO sweeps the legacy live-keyed v1 blobs',
    !migStore.has(v1('live-old')) && !migStore.has(v1('live-new')),
    [...migStore.keys()].join(','),
  )

  // Legacy-only: newest vintage wins, every mapped key removed.
  migStore.clear()
  migStore.set(v1('live-old'), '[{"old":true}]')
  migStore.set(v1('live-new'), '[{"new":true}]')
  const legacyOut = await tm.migrateV1TranscriptWith(migStorage, 'store-1', { v1, v2 }, sidMap)
  check('legacy branch returns the freshest vintage', legacyOut === '[{"new":true}]')
  check('legacy branch writes v2 from the freshest vintage', migStore.get(v2('store-1')) === '[{"new":true}]')
  check('legacy branch removes every mapped v1 key', !migStore.has(v1('live-old')) && !migStore.has(v1('live-new')))

  // Nothing to migrate: null, no writes.
  migStore.clear()
  const noneOut = await tm.migrateV1TranscriptWith(migStorage, 'store-2', { v1, v2 }, sidMap)
  check('no v1 blobs -> null and no v2 write', noneOut === null && !migStore.has(v2('store-2')))

  // ── Batch clarify send gate (BH-000025) ────────────────────────────────
  const cg = await import('../src/lib/clarifyGate')
  const qs = [
    { qid: 'q0', question: 'Plain', choices: ['a', 'b'] },
    { qid: 'q1', question: 'Free text' },
    { qid: 'q2', question: 'Multi', choices: ['x', 'y'], multi_select: true },
  ]
  check('no answers -> not ready (3 unanswered)', !cg.batchReady(qs, {}) && cg.countUnanswered(qs, {}) === 3)
  check('empty string counts as unanswered', cg.countUnanswered(qs, { q0: 'a', q1: '', q2: 'x' }) === 1)
  check('whitespace-only counts as unanswered', cg.countUnanswered(qs, { q0: 'a', q1: '   ', q2: 'x' }) === 1)
  check('all answered -> ready', cg.batchReady(qs, { q0: 'a', q1: 'typed', q2: 'x' }))
  check('multi_select with a selection list is answered', cg.countUnanswered(qs, { q0: 'a', q1: 'ok', q2: ['x', 'y'] }) === 0)
  check('multi_select with an empty selection list is unanswered', cg.countUnanswered(qs, { q0: 'a', q1: 'ok', q2: [] }) === 1)
  check('multi_select with only blank selections is unanswered', cg.countUnanswered(qs, { q0: 'a', q1: 'ok', q2: ['  '] }) === 1)
  check('empty question list is trivially ready', cg.batchReady([], {}))

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-queue crashed:', err)
  process.exit(1)
})
