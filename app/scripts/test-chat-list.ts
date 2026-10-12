// Unit tests for the sidebar chat-list layer (no gateway): marks (pin/archive)
// persistence round-trip + the pure section grouping, plus the pure session-row
// helpers (sessionRowMeta / sessionRunning / linkToast) behind the honest-row
// and running-dot fixes (#63/#75/#109/#111).
//
// AsyncStorage cannot load in plain node, so a fake is injected before the
// state module ever persists — the same pattern test-interactive.ts uses for
// the gateway module. The three helper modules are deliberately RN-free.
type ChatListState = typeof import('../src/lib/chatListState')
type SessionRowMeta = typeof import('../src/lib/sessionRowMeta')
type SessionRunning = typeof import('../src/lib/sessionRunning')
type LinkToast = typeof import('../src/lib/linkToast')

let mod: ChatListState

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

/** persist() writes fire-and-forget; give the fake storage a tick to land. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

async function main() {
  mod = await import('../src/lib/chatListState')
  mod._useStorageForTests(fakeStorage)

  // ── Marks: toggle + persistence ─────────────────────────────────────────
  mod.togglePin('a')
  check('togglePin pins', mod.isPinned('a'))
  await tick()
  check('pin persisted to storage', JSON.parse(backing.get('hermes.chatListMarks.v1') ?? '{}').pinned?.[0] === 'a')

  mod.togglePin('a')
  check('second togglePin unpins', !mod.isPinned('a'))

  mod.toggleArchive('b')
  mod.togglePin('b')
  check('pinning an archived chat unpins archive exclusivity', mod.isPinned('b') && !mod.isArchived('b'))

  mod.toggleArchive('c')
  mod.togglePin('c')
  mod.toggleArchive('c')
  check('archiving a pinned chat unpins', mod.isArchived('c') && !mod.isPinned('c'))

  mod.togglePin('persist-me')
  mod.toggleArchive('archive-me')
  await tick()
  const snapshot = backing.get('hermes.chatListMarks.v1')
  check('both marks persisted', !!snapshot?.includes('persist-me') && !!snapshot?.includes('archive-me'))

  // Reload path: reset atoms, load from storage.
  mod.pinnedIds.set([])
  mod.archivedIds.set([])
  await mod.loadChatMarks()
  check('loadChatMarks restores pinned', mod.isPinned('persist-me'))
  check('loadChatMarks restores archived', mod.isArchived('archive-me'))

  // Reload resilience: corrupt storage must not throw nor clobber with junk.
  backing.set('hermes.chatListMarks.v1', '{not json')
  await mod.loadChatMarks()
  check('corrupt marks payload is tolerated', Array.isArray(mod.pinnedIds.get()) && Array.isArray(mod.archivedIds.get()))

  // ── forgetChatMarks ──────────────────────────────────────────────────────
  mod.togglePin('gone')
  mod.toggleArchive('also-gone')
  mod.forgetChatMarks('gone')
  mod.forgetChatMarks('also-gone')
  mod.forgetChatMarks('never-marked')
  check('forgetChatMarks clears both marks', !mod.isPinned('gone') && !mod.isArchived('also-gone'))

  // ── Grouping ─────────────────────────────────────────────────────────────
  // Fixed "now" so buckets are deterministic regardless of the wall clock.
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime() // 2026-09-27 15:00 local
  const dayStart = mod.startOfDay(now)
  const rows = [
    { id: 'today-1', ts: dayStart + 3_600_000 },
    { id: 'today-2', ts: dayStart + 7_200_000 },
    { id: 'yest-1', ts: dayStart - 86_400_000 },
    { id: 'week-1', ts: dayStart - 4 * 86_400_000 },
    { id: 'old-1', ts: dayStart - 40 * 86_400_000 },
    { id: 'no-ts' }, // unknown activity → Older
    { id: 'pin-1', ts: dayStart - 30 * 86_400_000 },
    { id: 'arch-1', ts: dayStart + 1_000 },
  ]
  const groups = mod.groupChats(rows, ['pin-1'], ['arch-1'], now)
  const keys = groups.map((g) => g.key)
  check('sections are Pinned, Today, Yesterday, Previous 7 days, Older, Archived', JSON.stringify(keys) === JSON.stringify(['pinned', 'today', 'yesterday', 'week', 'older', 'archived']), keys.join(','))
  check('empty sections are omitted', !groups.some((g) => g.items.length === 0))
  check('pinned leads despite being oldest', keys[0] === 'pinned' && groups[0].items[0].id === 'pin-1')
  check('archived trails despite being newest', keys[keys.length - 1] === 'archived')
  const today = groups.find((g) => g.key === 'today')!
  check('within a section, newest first', today.items[0].id === 'today-2' && today.items[1].id === 'today-1')
  const older = groups.find((g) => g.key === 'older')!
  check('chat with no timestamp buckets to Older', older.items.some((r) => r.id === 'no-ts'))
  check('labels render', groups.find((g) => g.key === 'week')?.label === 'Previous 7 days')

  // Pin and archive are exclusive even if state got out of sync by hand.
  const clash = mod.groupChats(
    [{ id: 'x', ts: now }],
    ['x'],
    ['x'],
    now,
  )
  check('if both marks set, pin wins', clash.length === 1 && clash[0].key === 'pinned')

  // No marks → no Pinned/Archived sections at all.
  const plain = mod.groupChats(rows, [], [], now)
  check('no marks → only time sections', plain.every((g) => ['today', 'yesterday', 'week', 'older'].includes(g.key)))

  // ── Session row meta (#63/#111): honest source labels + counts ───────────
  const meta = (await import('../src/lib/sessionRowMeta')) as SessionRowMeta
  const running = (await import('../src/lib/sessionRunning')) as SessionRunning
  const toast = (await import('../src/lib/linkToast')) as LinkToast

  // sourceLabel: known token → tr() key resolved by the injected translator;
  // unknown token → the raw string; absent → ''.
  const fakeT = (k: string) => `[${k}]`
  check('sourceLabel localizes a known token', meta.sourceLabel('mobile', fakeT) === '[sessions.source.mobile]')
  check('sourceLabel is case/whitespace tolerant', meta.sourceLabel('  Cron ', fakeT) === '[sessions.source.cron]')
  check('sourceLabel keeps unknown tokens raw', meta.sourceLabel('irc', fakeT) === 'irc')
  check('sourceLabel empty when absent', meta.sourceLabel(undefined, fakeT) === '' && meta.sourceLabel('  ', fakeT) === '')

  // messageCountText: known counts verbatim, unknown → em-dash, never a 0 lie.
  check('messageCountText renders a real 0 as "0"', meta.messageCountText(0) === '0')
  check('messageCountText renders counts', meta.messageCountText(42) === '42')
  check('messageCountText renders unknown as "—" (BUG-111)', meta.messageCountText(undefined) === '—')
  check('messageCountText tolerates null/NaN', meta.messageCountText(null) === '—' && meta.messageCountText(Number.NaN) === '—')

  // searchHitToRow: the /api/sessions/search hit mapping — message_count and
  // source MUST pass through when the server sends them (it does —
  // web_routers/sessions.py), and MUST stay undefined (→ "— msgs") when not.
  const rich = meta.searchHitToRow({
    session_id: '20261012_abcd', snippet: 'lorem   ipsum\tdolor', title: 'Hit',
    started_at: 1760000000.5, profile: 'default', message_count: 7, source: 'cli',
  })!
  check('searchHitToRow keeps message_count (#111)', rich.message_count === 7)
  check('searchHitToRow keeps source', rich.source === 'cli')
  check('searchHitToRow keeps id/title/profile', rich.id === '20261012_abcd' && rich.title === 'Hit' && rich.profile === 'default')
  check('searchHitToRow collapses snippet whitespace', rich.preview === 'lorem ipsum dolor')
  const bare = meta.searchHitToRow({ session_id: 'x1', snippet: 'match' })!
  check('searchHitToRow leaves absent count undefined', bare.message_count === undefined && bare.source === undefined)
  check('searchHitToRow "—" decision applies to hits', meta.messageCountText(bare.message_count) === '—')
  check('searchHitToRow rejects hits without an id', meta.searchHitToRow({ snippet: 'orphan' }) === null)

  // optimisticSessionRow: a just-created chat has NO known count — undefined,
  // never the old hard 0 that read "0 msgs" until the next poll.
  const opt = meta.optimisticSessionRow('newly-created', 'New chat', 1760000100)
  check('optimistic row leaves message_count undefined', opt.message_count === undefined)
  check('optimistic row renders "— msgs"', meta.messageCountText(opt.message_count) === '—')
  check('optimistic row keeps id/title/started_at/source', opt.id === 'newly-created' && opt.title === 'New chat' && opt.started_at === 1760000100 && opt.source === 'mobile')

  // isDeleteRefusalBusy: the gateway's raw refusal (methods_session.py 4023)
  // is matched on its stable message — the code alone is shared by unrelated
  // validations, so it must NOT be sufficient.
  check('isDeleteRefusalBusy matches the known refusal', meta.isDeleteRefusalBusy(new Error('cannot delete an active session')))
  check('isDeleteRefusalBusy ignores other errors', !meta.isDeleteRefusalBusy(new Error('session not found')) && !meta.isDeleteRefusalBusy('cannot delete an active session'))

  // ── Running join (#75/BUG-131): active_list → rows → Set<storedId> ──────
  const rows2 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const run = (list: unknown) => running.joinRunningSessions(list as never, rows2)
  check('working/streaming/starting/resuming → running', (() => {
    const s = run([
      { session_key: 'a', status: 'working' },
      { session_key: 'b', status: 'streaming' },
      { session_key: 'c', status: 'starting' },
      { session_key: 'a', status: 'resuming' },
    ])
    return s.size === 3 && s.has('a') && s.has('b') && s.has('c')
  })())
  check('waiting → NOT running (attention owns it)', (() => {
    const s = run([{ session_key: 'a', status: 'waiting' }, { session_key: 'b', status: 'idle' }])
    return s.size === 0
  })())
  check('unmatched session_keys ignored', run([{ session_key: 'elsewhere', status: 'working' }]).size === 0)
  check('empty/null active_list → empty set', run([]).size === 0 && running.joinRunningSessions(null, rows2).size === 0 && running.joinRunningSessions(undefined, rows2).size === 0)
  check('malformed entries skipped', (() => {
    const s = run([null, {}, { session_key: 42, status: 'working' }, { session_key: 'a', status: 7 }, { session_key: 'a' }])
    return s.size === 0
  })())
  check('empty rows → empty set (nothing to mark)', running.joinRunningSessions([{ session_key: 'a', status: 'working' }], []).size === 0)

  // ── linkToast (#109): the toast lifecycle transition table ───────────────
  check('error sets the message', toast.linkToast(null, { type: 'error', message: 'boom' }) === 'boom')
  check('error with no message falls back', toast.linkToast('old', { type: 'error', message: '' }) === toast.LINK_TOAST_FALLBACK)
  check('reset clears (new link / connected)', toast.linkToast('boom', { type: 'reset' }) === null && toast.linkToast(null, { type: 'reset' }) === null)
  check('dismiss clears (tap)', toast.linkToast('boom', { type: 'dismiss' }) === null)
  check('timeout clears (7s auto-dismiss)', toast.linkToast('boom', { type: 'timeout' }) === null)
  // Note: the 7s timer itself and the Pressable live in app/_layout.tsx
  // (component-level, not extractable to plain node) — verified source-level.

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
