// Unit tests for the multi-session attention + drafts layers (no gateway,
// no RN): badge lifecycle + persistence, row-status priority, toast queue
// behaviour, deep-link target, and the per-chat draft store.
//
// AsyncStorage cannot load in plain node, so a fake is injected before the
// modules ever persist — the same pattern test-chat-list.ts uses.
type AttentionMod = typeof import('../src/lib/attention')
type DraftsMod = typeof import('../src/lib/drafts')

let att: AttentionMod
let drafts: DraftsMod

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
  att = await import('../src/lib/attention')
  drafts = await import('../src/lib/drafts')
  att._useStorageForTests(fakeStorage)
  drafts._useStorageForTests(fakeStorage)

  // ── Attention: mark / clear / priority ──────────────────────────────────
  att.markAttention('s1', 'input')
  check('markAttention records input', att.attentionById.get().s1?.kind === 'input')
  att.markAttention('s1', 'done')
  check('latest attention wins (input → done)', att.attentionById.get().s1?.kind === 'done')
  att.markAttention('s2', 'error')
  check('second chat tracked independently', att.attentionById.get().s2?.kind === 'error')

  check('rowStatus: attention beats busy', att.rowStatus(true, att.attentionById.get().s1) === 'done')
  check('rowStatus: busy when no attention', att.rowStatus(true, undefined) === 'busy')
  check('rowStatus: undefined when idle', att.rowStatus(false, undefined) === undefined)
  check('rowStatus: error surfaces over busy', att.rowStatus(true, { kind: 'error', at: 0 }) === 'error')

  att.clearAttention('s1')
  check('clearAttention drops the badge', att.attentionById.get().s1 === undefined)
  att.clearAttention('never-existed')
  check('clearAttention on unknown chat is a no-op', true)

  await tick()
  const saved = JSON.parse(backing.get('hermes.attention.v1') ?? '{}')
  check('attention persisted without the cleared chat', saved.s1 === undefined && saved.s2?.kind === 'error')

  // Reload path: reset atoms, load from storage.
  att.attentionById.set({})
  await att.loadAttention()
  check('loadAttention restores badges across restarts', att.attentionById.get().s2?.kind === 'error')

  // Prune beyond the tracking cap: oldest records fall off first.
  for (let i = 0; i < 105; i++) {
    att.markAttention(`bulk-${i}`, 'done')
    await tick()
  }
  const keys = Object.keys(att.attentionById.get())
  check('attention map capped at 100', keys.length === 100, `got ${keys.length}`)
  check('pruning keeps the newest', att.attentionById.get()['bulk-104'] !== undefined)
  check('pruning drops the oldest', att.attentionById.get()['bulk-0'] === undefined)

  // ── Toasts ──────────────────────────────────────────────────────────────
  att.toasts.set([])
  att.pushToast({ kind: 'input', title: 'Approval needed', body: 'rm -rf', storedId: 'a' })
  att.pushToast({ kind: 'done', title: 'Agent replied', body: 'hi', storedId: 'b' })
  check('toasts queue in order', att.toasts.get().length === 2)

  att.pushToast({ kind: 'input', title: 'Approval needed', body: 'updated command', storedId: 'a' })
  const afterReplace = att.toasts.get()
  check('same chat+kind replaces its toast', afterReplace.length === 2 && afterReplace[1].body === 'updated command')

  att.pushToast({ kind: 'error', title: 'Turn failed', body: 'x', storedId: 'c' })
  att.pushToast({ kind: 'done', title: 'Agent replied', body: 'y', storedId: 'd' })
  check('queue capped at three (oldest dropped)', att.toasts.get().length === 3 && !att.toasts.get().some((t) => t.storedId === 'b'))

  const id = att.toasts.get()[0].id
  att.dismissToast(id)
  check('dismissToast removes one', !att.toasts.get().some((t) => t.id === id))

  // ── Deep-link target ────────────────────────────────────────────────────
  att.requestOpenSession('chat-9')
  const target = att.pendingOpenStoredId.get()
  check('requestOpenSession records target', target?.storedId === 'chat-9' && typeof target?.at === 'number')
  check('target is fresh', target != null && Date.now() - target.at < 1000)

  // ── Drafts ──────────────────────────────────────────────────────────────
  drafts.drafts.set({})
  check('draftFor with no draft is empty', drafts.draftFor('a') === '')
  drafts.setDraft('a', 'finish this thought')
  check('setDraft stores per chat', drafts.draftFor('a') === 'finish this thought')
  drafts.setDraft('b', 'other chat')
  check('drafts are independent', drafts.draftFor('a') === 'finish this thought' && drafts.draftFor('b') === 'other chat')

  drafts.setDraft('a', '')
  check('empty draft clears', drafts.draftFor('a') === '')

  await drafts.flushDrafts()
  drafts.drafts.set({})
  await drafts.loadDrafts()
  check('drafts persist across restart', drafts.draftFor('b') === 'other chat' && drafts.draftFor('a') === '')

  // Cap: at most 60 drafts, oldest dropped.
  drafts.drafts.set({})
  for (let i = 0; i < 65; i++) drafts.setDraft(`d${i}`, `text ${i}`)
  await drafts.flushDrafts()
  const dkeys = Object.keys(drafts.drafts.get())
  check('drafts capped at 60', dkeys.length === 60, `got ${dkeys.length}`)
  check('draft cap keeps newest', drafts.draftFor('d64') === 'text 64')
  check('draft cap drops oldest', drafts.draftFor('d0') === '')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-attention crashed:', err)
  process.exit(1)
})
