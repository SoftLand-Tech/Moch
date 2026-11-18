/**
 * Unit tests for the canonical Bot Chat layer (UI-1, slice B) — no gateway,
 * no RN. A fake RPC + fake open deps are injected through the module's test
 * seams (the `_useSessionRpcForTests` pattern from lib/sessionList).
 *
 * Covered:
 *  1. existing `Bot Chat` row → lookup only, no create, opens the stored id
 *  2. missing row → create + title + open, with the exact wire params
 *  3. title conflict ("already in use") → adopt the winner, no second create
 *  4. lookup RPC throws → openBotChat throws and creates NOTHING
 * Plus the supporting rules: trimmed exact-title matching, `resolved_id`
 * pass-through, roster-says-it-exists fail-closed, single-flight, and the
 * title-write failure paths.
 *
 *   npx tsx scripts/test-bot-chat.ts
 */

type BotChatMod = typeof import('../src/lib/botChat')

// `scripts/**` is one program: without this the file is a GLOBAL script and
// its `pass`/`fail`/`check` collide with the other offline suites.
export {}

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** One recorded RPC call. */
interface Call {
  method: string
  params: Record<string, unknown>
}

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

/** Build a fake rpc() from a method table; records every frame. */
function fakeRpc(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const rpc = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ method, params })
    const h = handlers[method]
    if (!h) throw new Error(`unexpected RPC ${method}`)
    return (await h(params)) as T
  }
  return { rpc: rpc as unknown as typeof import('../src/lib/gateway')['rpc'], calls }
}

const callsTo = (calls: Call[], method: string) => calls.filter((c) => c.method === method)

async function main() {
  const mod: BotChatMod = await import('../src/lib/botChat')
  const { openBotChat, findBotChat, BOT_CHAT_TITLE } = mod

  // The opener is a seam too: real apps resume the chat on screen; the suite
  // only asserts WHICH stored id was opened (and how many times).
  let opened: string[] = []
  let active: string | null = null
  mod._useBotChatDepsForTests({
    setActiveBot: (profile) => { active = profile },
    openChat: async (storedId) => { opened.push(storedId); active = storedId },
  })

  check('BOT_CHAT_TITLE is the exact canonical name', BOT_CHAT_TITLE === 'Bot Chat')

  // ── 1. existing row opens, nothing is minted ──────────────────────────────
  {
    opened = []
    active = null
    const { rpc, calls } = fakeRpc({
      'session.list': () => ({
        sessions: [
          { id: 'ignored-1', title: 'Some other chat' },
          { id: 'bot-chat-1', resolved_id: 'tip-1', title: '  Bot Chat  ', message_count: 12 },
        ],
      }),
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests(() => false)

    const id = await openBotChat('researcher')
    check('existing row: returns the STORED id', id === 'bot-chat-1', id)
    check('existing row: opens that chat', opened.length === 1 && opened[0] === 'bot-chat-1')
    check('existing row: scopes the bot first', active === 'bot-chat-1')
    check('existing row: no session.create', callsTo(calls, 'session.create').length === 0)
    check('existing row: no session.title', callsTo(calls, 'session.title').length === 0)

    const listCall = callsTo(calls, 'session.list')[0]
    check(
      'existing row: lookup frame is the exact-title contract',
      JSON.stringify(listCall.params) ===
        JSON.stringify({ profile: 'researcher', title: 'Bot Chat', limit: 50, include_hidden: true }),
      JSON.stringify(listCall.params),
    )

    // findBotChat alone: ref carries storedId + resolved tip.
    const ref = await findBotChat('researcher')
    check('findBotChat returns storedId', ref?.storedId === 'bot-chat-1')
    check('findBotChat passes resolved_id as resolvedId', ref?.resolvedId === 'tip-1')
    check('findBotChat never opens anything', opened.length === 1)
  }

  // ── 2. missing row creates + titles + opens ──────────────────────────────
  {
    opened = []
    const { rpc, calls } = fakeRpc({
      // First lookup: nothing, and the roster has no evidence either.
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'live-9', stored_session_id: 'stored-9' }),
      'session.title': () => ({ title: 'Bot Chat', session_key: 'stored-9', pending: false }),
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests(() => false)

    const id = await openBotChat('writer')
    check('missing row: returns the created stored id', id === 'stored-9', id)
    check('missing row: opens the created chat', opened.length === 1 && opened[0] === 'stored-9')

    const create = callsTo(calls, 'session.create')
    check('missing row: exactly one create', create.length === 1)
    check(
      'missing row: create frame is canonical (hidden + profile config + mobile)',
      JSON.stringify(create[0].params) ===
        JSON.stringify({
          profile: 'writer',
          title: 'Bot Chat',
          hidden: true,
          follow_profile_config: true,
          cols: 80,
          source: 'mobile',
        }),
      JSON.stringify(create[0].params),
    )
    const title = callsTo(calls, 'session.title')
    check('missing row: exactly one title write', title.length === 1)
    check(
      'missing row: title targets the RUNTIME id with the canonical name',
      JSON.stringify(title[0].params) === JSON.stringify({ session_id: 'live-9', title: 'Bot Chat' }),
      JSON.stringify(title[0].params),
    )
    check(
      'missing row: create happens before title',
      calls.findIndex((c) => c.method === 'session.create') <
        calls.findIndex((c) => c.method === 'session.title'),
    )

    // No stored_session_id on the wire → the runtime id is the durable one.
    opened = []
    const bare = fakeRpc({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'only-live' }),
      'session.title': () => ({ title: 'Bot Chat', pending: false }),
    })
    mod._useBotChatRpcForTests(bare.rpc)
    const bareId = await openBotChat('bare')
    check('missing row: falls back to runtime id as stored id', bareId === 'only-live', bareId)

    // A title write that comes back PENDING means the gateway queued the name
    // (it lands with the first prompt / next title read). The chat exists and
    // is resumable, so the tap must still open it — just never pretend more.
    opened = []
    const pending = fakeRpc({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'live-p', stored_session_id: 'stored-p' }),
      'session.title': () => ({ title: 'Bot Chat', pending: true }),
    })
    mod._useBotChatRpcForTests(pending.rpc)
    const pendingId = await openBotChat('pending-bot')
    check('pending title write: still opens the created chat', pendingId === 'stored-p' && opened[0] === 'stored-p', pendingId)

    // Create succeeding but the title write failing for a NON-conflict reason
    // is a hard failure too — the row would be an unnamed duplicate trap.
    opened = []
    const titleBoom = fakeRpc({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'live-b', stored_session_id: 'stored-b' }),
      'session.title': () => { throw new Error('title too long') },
    })
    mod._useBotChatRpcForTests(titleBoom.rpc)
    let titleErr = ''
    try { await openBotChat('title-boom') } catch (e) { titleErr = e instanceof Error ? e.message : String(e) }
    check('title write failure: throws with the why', /title too long/.test(titleErr), titleErr)
    check('title write failure: nothing opened', opened.length === 0)
    check('title write failure: only one create attempted', callsTo(titleBoom.calls, 'session.create').length === 1)
  }

  // ── 3. title conflict adopts the winner ──────────────────────────────────
  {
    opened = []
    const { rpc, calls } = fakeRpc({
      // Lookup misses, then (after the rejected title) finds the winner.
      'session.list': (() => {
        let n = 0
        return () => (++n === 1
          ? { sessions: [] }
          : { sessions: [{ id: 'winner-1', resolved_id: 'winner-tip', title: 'Bot Chat' }] })
      })(),
      'session.create': () => ({ session_id: 'loser-live', stored_session_id: 'loser-stored' }),
      'session.title': () => {
        throw new Error("Title 'Bot Chat' is already in use by session winner-1")
      },
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests(() => false)

    const id = await openBotChat('racer')
    check('conflict: adopts the winner stored id', id === 'winner-1', id)
    check('conflict: opens the winner', opened.length === 1 && opened[0] === 'winner-1')
    check('conflict: never opens the losing draft', !opened.includes('loser-stored'))
    check('conflict: re-runs the lookup exactly once', callsTo(calls, 'session.list').length === 2)
    check('conflict: does NOT create a second session', callsTo(calls, 'session.create').length === 1)

    // Conflict + a lookup that still cannot see the winner: fail closed.
    opened = []
    const blind = fakeRpc({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'blind-live', stored_session_id: 'blind-stored' }),
      'session.title': () => { throw new Error('Title already in use') },
    })
    mod._useBotChatRpcForTests(blind.rpc)
    let blindErr = ''
    try { await openBotChat('blind') } catch (e) { blindErr = e instanceof Error ? e.message : String(e) }
    check('conflict without a visible winner: throws', !!blindErr, blindErr)
    check('conflict without a visible winner: nothing opened', opened.length === 0)
    check('conflict without a visible winner: no second create', callsTo(blind.calls, 'session.create').length === 1)
  }

  // ── 4. lookup RPC failure: throw, never mint ─────────────────────────────
  {
    opened = []
    const { rpc, calls } = fakeRpc({
      'session.list': () => { throw new Error('socket closed') },
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests(() => false)

    let err = ''
    try { await openBotChat('offline-bot') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    check('lookup failure: openBotChat throws', !!err, err)
    check('lookup failure: error names the bot', /offline-bot/.test(err), err)
    check('lookup failure: never created', callsTo(calls, 'session.create').length === 0)
    check('lookup failure: never titled', callsTo(calls, 'session.title').length === 0)
    check('lookup failure: nothing opened', opened.length === 0)
    check('lookup failure: recorded in botChatError', /offline-bot/.test(mod.botChatError.get()), mod.botChatError.get())

    // findBotChat on its own fails closed too — it must not read as "absent".
    let findErr = ''
    try { await findBotChat('offline-bot') } catch (e) { findErr = e instanceof Error ? e.message : String(e) }
    check('lookup failure: findBotChat throws (never null)', !!findErr, findErr)
  }

  // ── Roster evidence: an empty answer is NOT proof of absence ─────────────
  {
    opened = []
    const { rpc, calls } = fakeRpc({
      'session.list': () => ({ sessions: [] }),
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests((p) => p === 'known-bot')

    let err = ''
    try { await openBotChat('known-bot') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    check('roster says canonical exists but list is empty: throws', !!err, err)
    check('roster evidence: never mints', callsTo(calls, 'session.create').length === 0)
    check('roster evidence: nothing opened', opened.length === 0)

    // And the roster evidence for a DIFFERENT profile must not block this one.
    opened = []
    const other = fakeRpc({
      'session.list': () => ({ sessions: [] }),
      'session.create': () => ({ session_id: 'live-o', stored_session_id: 'stored-o' }),
      'session.title': () => ({ title: 'Bot Chat', pending: false }),
    })
    mod._useBotChatRpcForTests(other.rpc)
    const oid = await openBotChat('brand-new-bot')
    check('roster evidence is per-profile', oid === 'stored-o', oid)
  }

  // ── Single-flight: a double-tap shares one open ──────────────────────────
  {
    opened = []
    const { rpc, calls } = fakeRpc({
      'session.list': () => ({ sessions: [{ id: 'shared-1', title: 'Bot Chat' }] }),
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests(() => false)

    const [a, b] = await Promise.all([openBotChat('double'), openBotChat('double')])
    check('single-flight: both taps resolve to the same id', a === 'shared-1' && b === 'shared-1', `${a} / ${b}`)
    check('single-flight: one lookup only', callsTo(calls, 'session.list').length === 1)
    check('single-flight: opened once', opened.length === 1)

    // Different profiles stay independent.
    opened = []
    const two = fakeRpc({
      'session.list': () => ({ sessions: [{ id: 'p-chat', title: 'Bot Chat' }] }),
    })
    mod._useBotChatRpcForTests(two.rpc)
    await Promise.all([openBotChat('one'), openBotChat('two')])
    check('single-flight is per profile', callsTo(two.calls, 'session.list').length === 2)
  }

  // ── Empty profile name is rejected before any RPC ────────────────────────
  {
    const { rpc, calls } = fakeRpc({})
    mod._useBotChatRpcForTests(rpc)
    let err = ''
    try { await openBotChat('   ') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    check('blank profile: rejects', !!err, err)
    check('blank profile: no RPCs', calls.length === 0)
  }

  // ── Stale canonical row: resume fails "session not found" → recover ──────
  {
    opened = []
    active = null
    const { rpc, calls } = fakeRpc({
      // First lookup: the stale row exists. After the best-effort delete the
      // re-lookup (none needed here — the create path succeeds directly) and
      // the recovery's lookup still report an empty registry.
      'session.list': (() => {
        let n = 0
        return () => (++n === 1
          ? { sessions: [{ id: 'stale-1', title: 'Bot Chat' }] }
          : { sessions: [] })
      })(),
      'session.delete': (params) => {
        if (params.session_id !== 'stale-1') throw new Error('unexpected delete target')
        return { ok: true }
      },
      'session.create': () => ({ session_id: 'fresh-live', stored_session_id: 'fresh-stored' }),
      'session.title': () => ({ title: 'Bot Chat', pending: false }),
    })
    mod._useBotChatRpcForTests(rpc)
    mod._useBotChatRosterForTests(() => false)
    // The real resume throws "session not found" for the stale row; every
    // later open (the fresh canonical) succeeds.
    const realDeps = mod._useBotChatDepsForTests
    let openCalls = 0
    let newChats = 0
    realDeps({
      setActiveBot: (profile) => { active = profile },
      openChat: async (storedId) => {
        openCalls++
        if (openCalls === 1) throw new Error('session not found: stale-1')
        opened.push(storedId)
        active = storedId
      },
      newChat: async () => { newChats++; return 'fallback-chat' },
    })

    let id = ''
    let err = ''
    try { id = await openBotChat('stale-bot') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    check('stale row: no error escapes', !err, err)
    check('stale row: the FRESH canonical is opened', opened.includes('fresh-stored') && !opened.includes('stale-1'), opened.join(','))
    check('stale row: resolves to the fresh stored id', id === 'fresh-stored', id)
    check('stale row: the stale row is deleted', callsTo(calls, 'session.delete').length === 1)
    check('stale row: delete targets the STALE id', JSON.stringify(callsTo(calls, 'session.delete')[0]?.params) === JSON.stringify({ session_id: 'stale-1' }))
    check('stale row: a fresh canonical is minted', callsTo(calls, 'session.create').length === 1)
    check('stale row: bot stays scoped', active === 'fresh-stored', String(active))
    check('stale row: newChat fallback NOT used (mint succeeded)', newChats === 0)

    // Recovery whose mint ALSO fails falls back to a fresh bot-scoped chat.
    opened = []
    const mintBoom = fakeRpc({
      'session.list': () => ({ sessions: [{ id: 'stale-2', title: 'Bot Chat' }] }),
      'session.create': () => { throw new Error('gateway down') },
    })
    let fellBack = ''
    mod._useBotChatRpcForTests(mintBoom.rpc)
    mod._useBotChatDepsForTests({
      setActiveBot: () => {},
      openChat: async () => { throw new Error('session not found') },
      newChat: async () => { fellBack = 'fallback-2'; return 'fallback-2' },
    })
    id = ''
    err = ''
    try { id = await openBotChat('stale-bot-2') } catch (e) { err = e instanceof Error ? e.message : String(e) }
    check('stale row: mint failure still resolves via fallback', !err && id === 'fallback-2', err || id)
    check('stale row: fallback chat is opened in the app too', fellBack === 'fallback-2')

    // Restore the happy-path deps for the suites below.
    opened = []
    realDeps({
      setActiveBot: (profile) => { active = profile },
      openChat: async (storedId) => { opened.push(storedId); active = storedId },
      newChat: async () => 'new-chat',
    })
  }

  // Reset the injected seams so nothing leaks past this suite.
  mod._useBotChatRpcForTests(null)
  mod._useBotChatRosterForTests(null)
  mod._useBotChatDepsForTests(null)

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
