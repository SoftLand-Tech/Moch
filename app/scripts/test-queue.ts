// Unit tests for the busy-queue layer (no gateway, no RN): messages sent
// while a turn was running queue per chat, oldest first, capped, persisted.
//
// AsyncStorage cannot load in plain node, so a fake is injected before the
// module ever persists — the same pattern test-attention.ts uses.
type QueueMod = typeof import('../src/lib/sendQueue')

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
