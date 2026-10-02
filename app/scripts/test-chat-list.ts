// Unit tests for the sidebar chat-list layer (no gateway): marks (pin/archive)
// persistence round-trip + the pure section grouping.
//
// AsyncStorage cannot load in plain node, so a fake is injected before the
// state module ever persists — the same pattern test-interactive.ts uses for
// the gateway module.
type ChatListState = typeof import('../src/lib/chatListState')

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

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
