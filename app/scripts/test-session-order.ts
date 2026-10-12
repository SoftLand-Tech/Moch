// Offline unit tests for src/lib/sessionList.ts — the drawer/chat-list ORDER.
//
// History (BUG-012 / tracker BH-000027): this suite used to dial a LIVE
// gateway (ws://127.0.0.1:9119, token from ~/.config/hermes-serve.env) and
// re-implemented the module's sort in a local MIRROR — a mirror that kept
// sorting by `started_at` long after the real module had deleted that sort.
// It passed while testing code that no longer existed. It now runs against
// the REAL module with zero network: storage is faked (test-queue.ts pattern)
// and `session.list` answers come from an injected fake RPC
// (`_useSessionRpcForTests`, the same seam shape as the storage one).
//
// The headline contract pinned below: rows from `session.list` are applied
// in SERVER order (order_by_last_active) and are NEVER re-sorted client-side
// by the immutable creation-time `started_at`.
type SessionList = typeof import('../src/lib/sessionList')

let m: SessionList

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
  m = await import('../src/lib/sessionList')
  m._useLastActiveStorageForTests(fakeStorage)

  // ── toMs: unit-defense around fractional-seconds started_at ────────────
  check('toMs treats fractional seconds as seconds', m.toMs(1.5) === 1500)
  check('toMs keeps a realistic seconds epoch ×1000', m.toMs(1_760_000_000) === 1_760_000_000_000)
  check('toMs passes millisecond epochs (>1e12) through', m.toMs(1_769_999_999_999) === 1_769_999_999_999)
  check('toMs passes the 1e10–1e12 ms band through unscaled', m.toMs(1.1e10) === 1.1e10 && m.toMs(5e11) === 5e11)
  check('toMs maps the exact 1e10 edge to seconds (×1000)', m.toMs(1e10) === 1e13)
  check(
    'toMs returns 0 for non-finite/non-positive/non-number input',
    m.toMs(0) === 0 && m.toMs(-5) === 0 && m.toMs(NaN) === 0 && m.toMs(Infinity) === 0 &&
      m.toMs(null) === 0 && m.toMs(undefined) === 0 && m.toMs('123' as unknown as number) === 0,
  )

  // ── loadLastActive: parse + validate from storage ──────────────────────
  // Seed BEFORE the first load — the latch means storage is read once.
  backing.set('hermes.lastActiveMap.v1', JSON.stringify({
    good1: 1700000000000,
    good2: 1700000001000,
    badStr: 'yesterday',
    badNeg: -1,
    badNull: null,
    badZero: 0,
  }))
  await m.loadLastActive()
  const map1 = m.lastActiveByStoredId.get()
  check(
    'loadLastActive keeps only finite positive numbers',
    map1.good1 === 1700000000000 && map1.good2 === 1700000001000 &&
      !('badStr' in map1) && !('badNeg' in map1) && !('badNull' in map1) && !('badZero' in map1),
    Object.keys(map1).join(','),
  )
  backing.set('hermes.lastActiveMap.v1', JSON.stringify({ sneaky: 123 }))
  await m.loadLastActive() // latch: must NOT re-read
  check('loadLastActive latches — later storage changes are invisible', !('sneaky' in m.lastActiveByStoredId.get()))

  // Corrupt JSON must not throw the loader. The latch is per module
  // instance, so exercise it on a FRESH instance (query-busted import —
  // node treats '?k=v' as a distinct module record) with its own storage.
  const corruptBacking = new Map([['hermes.lastActiveMap.v1', '{not json']])
  // '?corrupt=1' busts node's module cache (fresh instance) but TS cannot
  // resolve it as a literal — indirect through a string + cast to the REAL
  // module's type so the suite keeps full checking.
  const bust = '../src/lib/sessionList?corrupt=1' as string
  const fresh = (await import(bust)) as typeof import('../src/lib/sessionList')
  fresh._useLastActiveStorageForTests({
    getItem: async (k) => corruptBacking.get(k) ?? null,
    setItem: async (k, v) => void corruptBacking.set(k, v),
  })
  await fresh.loadLastActive()
  check('corrupt storage payload is tolerated (logged, empty map)', Object.keys(fresh.lastActiveByStoredId.get()).length === 0)

  // ── bumpSessionActivity: local revive-to-top overlay ───────────────────
  m.sessionRows.set([
    { id: 'front', title: 'front' },
    { id: 'mid', title: 'mid' },
    { id: 'back', title: 'back' },
  ])
  const rowsBefore = m.sessionRows.get()
  m.bumpSessionActivity('back')
  check('bump moves the row to the front', m.sessionRows.get().map((r) => r.id).join(',') === 'back,front,mid')
  check('bump reuses the same row objects (no row clones)', m.sessionRows.get()[0] === rowsBefore[2])
  check('bump stamps lastActive and persists', m.lastActiveFor('back') > 0)
  await tick()
  check('bump persist landed in storage', (backing.get('hermes.lastActiveMap.v1') ?? '').includes('"back"'))

  m.bumpSessionActivity('back') // already at front
  check('bumping the front row leaves order alone', m.sessionRows.get()[0]?.id === 'back')
  m.bumpSessionActivity('unknown-id')
  check('bumping an unknown id keeps rows, still stamps the map', m.sessionRows.get().length === 3 && m.lastActiveFor('unknown-id') > 0)

  m.lastActiveByStoredId.set({})
  const beforeNew = JSON.stringify(m.lastActiveByStoredId.get())
  m.bumpSessionActivity('new:m1_2') // pseudo id — an offline-enqueued draft, never a stored chat
  check(
    'new:* pseudo ids are a full no-op',
    !m.sessionRows.get().some((r) => r.id === 'new:m1_2') &&
      JSON.stringify(m.lastActiveByStoredId.get()) === beforeNew,
  )

  // 200-entry cap: bump 205 distinct ids, oldest evicted, newest kept.
  m.lastActiveByStoredId.set({})
  for (let i = 0; i < 205; i++) m.bumpSessionActivity(`cap-${i}`)
  const capped = m.lastActiveByStoredId.get()
  const capKeys = Object.keys(capped)
  check('last-active map caps at 200 entries', capKeys.length === 200, `got ${capKeys.length}`)
  check('cap keeps the NEWEST 200 (first five evicted)', !('cap-0' in capped) && !('cap-4' in capped) && 'cap-5' in capped && 'cap-204' in capped)

  // ── THE contract: server rows applied WITHOUT re-sorting (BUG-012) ─────
  m.resetSessionList()
  let rpcCalls = 0
  let seenParams: Record<string, unknown> | null = null
  // Deliberately "wrong" for started_at: the server orders by LAST ACTIVITY,
  // so an actively-used OLD chat (started first) sits ABOVE a newer-but-idle
  // one. Any client-side started_at re-sort would destroy exactly this.
  const serverOrder = [
    { id: 's-old-active', title: 'old but busy', started_at: 1_600_000_000.5 },
    { id: 's-new-idle', title: 'new but idle', started_at: 1_760_000_000.9 },
    { id: 's-mid', title: 'middle', started_at: 1_700_000_000.1 },
  ]
  m._useSessionRpcForTests(async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
    rpcCalls++
    seenParams = params ?? null
    if (method !== 'session.list') throw new Error(`unexpected method ${method}`)
    return { sessions: serverOrder } as T
  })
  const loaded = await m.loadSessions()
  check('loadSessions returns the server rows', loaded.length === 3)
  check(
    'NO client re-sort: server (last-activity) order passes through exactly',
    m.sessionRows.get().map((r) => r.id).join(',') === 's-old-active,s-new-idle,s-mid',
    m.sessionRows.get().map((r) => r.id).join(','),
  )
  check('the returned list matches the store (one order, one truth)', loaded === m.sessionRows.get() || loaded.map((r) => r.id).join(',') === m.sessionRows.get().map((r) => r.id).join(','))
  check('asks for the full 1000-row window (BUG-020)', (seenParams as Record<string, unknown> | null)?.limit === 1000, JSON.stringify(seenParams))
  check('complete flag set when under the limit', m.sessionListComplete.get() === true)
  check('no error after a good load', m.sessionListError.get() === null)

  // Concurrent callers share ONE fetch.
  rpcCalls = 0
  const p1 = m.loadSessions()
  const p2 = m.loadSessions()
  const [r1, r2] = await Promise.all([p1, p2])
  check('concurrent loads share one rpc (in-flight dedup)', rpcCalls === 1 && r1.length === 3 && r2.length === 3, `${rpcCalls} calls`)

  // Error path keeps the old rows instead of blanking the list.
  m._useSessionRpcForTests(async <T,>(): Promise<T> => {
    throw new Error('gateway exploded')
  })
  const kept = await m.loadSessions()
  check('a failing fetch keeps the previous rows', kept.length === 3 && m.sessionRows.get().length === 3)
  check('a failing fetch surfaces the error', m.sessionListError.get() === 'gateway exploded')

  // Generation guard (BUG-024): a reset mid-flight must beat a stale answer.
  m.resetSessionList()
  let release!: (v: unknown) => void
  m._useSessionRpcForTests(<T,>() => new Promise<T>((res) => { release = res as (v: unknown) => void }))
  const slow = m.loadSessions()
  m.resetSessionList() // backend switch while the fetch is in flight
  release({ sessions: [{ id: 'stale', title: 'from the old backend' }] })
  await slow
  check(
    'a response superseded by resetSessionList writes nothing (BUG-024)',
    m.sessionRows.get().length === 0 && m.sessionListError.get() === null,
  )
  m._useSessionRpcForTests(null)

  // ── Optimistic rows + title patching ────────────────────────────────────
  m.resetSessionList()
  m.upsertOptimisticRow('fresh-1', 'Brand new chat')
  check('optimistic row is PREPENDED (a fresh chat is the most recent)', m.sessionRows.get()[0]?.id === 'fresh-1')
  m.upsertOptimisticRow('fresh-1', 'Renamed immediately')
  check('re-upsert of an existing row updates the title in place', m.sessionRows.get().length === 1 && m.sessionRows.get()[0]?.title === 'Renamed immediately')
  m.sessionRows.set([{ id: 'row-a', title: 'old title' }])
  m.patchRowTitle(['row-a', 'live-9'], 'new title')
  check('patchRowTitle renames via any candidate id', m.sessionRows.get()[0]?.title === 'new title')
  m.patchRowTitle(['ghost'], 'nope')
  check('patchRowTitle ignores unknown ids', m.sessionRows.get()[0]?.title === 'new title' && m.sessionRows.get().length === 1)

  // ── No-mutation of inputs ───────────────────────────────────────────────
  const frozenRows = [
    { id: 'f-front', title: 'a' },
    { id: 'f-back', title: 'b' },
  ]
  Object.freeze(frozenRows[0])
  Object.freeze(frozenRows[1])
  Object.freeze(frozenRows)
  m.sessionRows.set(frozenRows)
  m.bumpSessionActivity('f-back')
  check('move-to-front builds a NEW array (frozen input untouched)', m.sessionRows.get() !== frozenRows && m.sessionRows.get().map((r) => r.id).join(',') === 'f-back,f-front')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-session-order crashed:', err)
  process.exit(1)
})
