// Unit tests for the "Ask Moch" share-in inbox (src/lib/shareIn.ts): payload
// normalization, draft merging, the inbox lifecycle against a fake native
// module, and the initShareIn event wiring — no RN, no device (same
// constraint/contract as test-queue.ts / test-media.ts).
type ShareInMod = typeof import('../src/lib/shareIn')
type SharedPayload = import('../src/lib/shareIn').SharedPayload

let m: ShareInMod

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

async function main() {
  m = await import('../src/lib/shareIn')

  // ── normalizeSharedPayload ──────────────────────────────────────────────
  check('null raw → null', m.normalizeSharedPayload(null) === null)
  check('undefined raw → null', m.normalizeSharedPayload(undefined) === null)

  const norm = m.normalizeSharedPayload({
    text: '  look at this  ',
    subject: '  A page  ',
    files: [{ uri: 'file:///c/share-in/1-photo.jpg', name: 'photo.jpg', size: 1000, mime: 'image/jpeg' }],
    skipped: 0,
    at: 1234,
  })
  check(
    'text/subject trimmed, file kept',
    norm !== null && norm.text === 'look at this' && norm.subject === 'A page' && norm.files.length === 1 && norm.at === 1234,
  )

  const capped = m.normalizeSharedPayload({ text: 'x'.repeat(9000), subject: 's'.repeat(400), files: [], skipped: 0, at: 0 })
  check(
    'text capped at 8000, subject at 300',
    capped !== null && capped.text.length === 8000 && capped.subject.length === 300,
  )

  const manyFiles = m.normalizeSharedPayload({
    text: '',
    subject: '',
    files: [1, 2, 3, 4, 5, 6].map((i) => ({ uri: `file:///c/${i}.jpg`, name: `${i}.jpg` })),
    skipped: 0,
    at: 0,
  })
  check('files capped at MAX_ATTACHMENTS (4)', manyFiles !== null && manyFiles.files.length === 4)

  const badFiles = m.normalizeSharedPayload({
    text: 'hi',
    subject: '',
    files: [{ name: 'nourl.jpg' } as never, { uri: '', name: 'empty.jpg' } as never, { uri: 'file:///c/ok.jpg', name: 'ok.jpg' }],
    skipped: 0,
    at: 0,
  })
  check('files without a uri dropped, valid ones kept', badFiles !== null && badFiles.files.length === 1 && badFiles.files[0]!.name === 'ok.jpg')

  check('all-empty payload → null', m.normalizeSharedPayload({ text: '   ', subject: '', files: [], skipped: 0, at: 0 }) === null)
  check(
    'subject-only payload survives (EXTRA_TEXT empty)',
    m.normalizeSharedPayload({ text: '', subject: 'An article title', files: [], skipped: 0, at: 5 })?.subject === 'An article title',
  )
  check(
    'skipped sanitized: negative → 0, NaN → 0',
    m.normalizeSharedPayload({ text: 'a', subject: '', files: [], skipped: -3, at: 0 })!.skipped === 0 &&
      m.normalizeSharedPayload({ text: 'a', subject: '', files: [], skipped: Number.NaN, at: 0 })!.skipped === 0,
  )

  // ── applySharedToDraft ─────────────────────────────────────────────────
  const sh = { text: 'summarize this', subject: '', files: [], skipped: 0, at: 0 }
  check('draft merge into empty draft', m.applySharedToDraft('', sh) === 'summarize this')
  check('draft merge joins with a blank line', m.applySharedToDraft('draft in progress', sh) === 'draft in progress\n\nsummarize this')
  check(
    'subject is the fallback when text is empty',
    m.applySharedToDraft('', { ...sh, text: '', subject: 'A page title' }) === 'A page title',
  )
  const noText = { text: '', subject: '', files: [{ uri: 'file:///c/p.jpg', name: 'p.jpg' }], skipped: 0, at: 0 }
  check('file-only share leaves the draft untouched', m.applySharedToDraft('keep me', noText) === 'keep me')

  // ── inbox lifecycle against a fake native module ────────────────────────
  m.ackShareIn()
  let nextRaw: SharedPayload | null = null
  m._useNativeForTests({ take: async () => nextRaw })

  nextRaw = { text: 'shared words', subject: '', files: [], skipped: 0, at: 1 }
  check('pullSharedIntoInbox delivers into the inbox', (await m.pullSharedIntoInbox()) && m.shareInInbox.get()?.text === 'shared words')
  nextRaw = null
  check('empty relay: pull is false, inbox intact', !(await m.pullSharedIntoInbox()) && m.shareInInbox.get()?.text === 'shared words')
  m.ackShareIn()
  check('ack clears the inbox', m.shareInInbox.get() === null)
  nextRaw = { text: '   ', subject: '', files: [], skipped: 0, at: 0 }
  check('unusable payload: pull false, inbox stays clear', !(await m.pullSharedIntoInbox()) && m.shareInInbox.get() === null)
  m._useNativeForTests({ take: async () => { throw new Error('native went away') } })
  check('native throw: pull is false, no unhandled rejection', !(await m.pullSharedIntoInbox()))
  m._useNativeForTests(null)

  // ── initShareIn: cold-start pull + event nudge + cleanup ────────────────
  m._useNativeForTests(null)
  const listeners: Array<() => void> = []
  const fired: number[] = []
  const fakeEmitter = {
    addListener(_name: string, cb: () => void) {
      listeners.push(cb)
      return { remove: () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } }
    },
  }
  let takeCount = 0
  let current: SharedPayload | null = { text: 'cold start share', subject: '', files: [], skipped: 0, at: 9 }
  m._useNativeForTests({ take: async () => { takeCount++; const r = current; current = null; return r } }, fakeEmitter)

  const off = m.initShareIn(() => fired.push(Date.now()))
  for (let i = 0; i < 20 && fired.length === 0; i++) await tick()
  check('initShareIn cold-start pull delivered + routed', fired.length === 1 && m.shareInInbox.get()?.text === 'cold start share')

  current = { text: 'event share', subject: '', files: [], skipped: 0, at: 10 }
  listeners.forEach((cb) => cb())
  for (let i = 0; i < 20 && fired.length === 1; i++) await tick()
  check('MochShareIn event → pull → route', fired.length === 2 && m.shareInInbox.get()?.text === 'event share')

  off()
  current = { text: 'after cleanup', subject: '', files: [], skipped: 0, at: 11 }
  listeners.forEach((cb) => cb())
  for (let i = 0; i < 5; i++) await tick()
  check('cleanup unsubscribes the emitter (no third take)', fired.length === 2 && takeCount === 2)

  m.ackShareIn()
  m._useNativeForTests(null, null)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-sharein crashed:', err)
  process.exit(1)
})
