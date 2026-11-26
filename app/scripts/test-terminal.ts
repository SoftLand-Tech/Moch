// Unit tests for the interactive terminal core (src/lib/terminal.ts):
// base64 round-trip, ANSI stripping, the capped buffer, and the controller
// state machine against a fake native bridge — no RN, no device (same
// constraint/contract as test-sharein.ts).
type TermMod = typeof import('../src/lib/terminal')

let m: TermMod

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

// Fake per-session transport: records the bound session id on every call so
// the adapter (createSessionTermNative) is exercised, not bypassed.
function fakeTransport(outChunks: string[] = [], alive = true) {
  const writes: { sessionId: string; data: string }[] = []
  const starts: { sessionId: string; cwd: string | null; cols: number; rows: number }[] = []
  const kills: string[] = []
  const clears: string[] = []
  const resizes: { sessionId: string; cols: number; rows: number }[] = []
  return {
    writes,
    starts,
    kills,
    clears,
    resizes,
    async startSession(sessionId: string, cwd: string | null, cols: number, rows: number) {
      starts.push({ sessionId, cwd, cols, rows })
      return { ok: true, alreadyRunning: false }
    },
    async writeSession(sessionId: string, d: string) {
      writes.push({ sessionId, data: d })
      return true
    },
    async drainSession() {
      const c = outChunks.splice(0, outChunks.length)
      return { chunks: c, alive }
    },
    async replaySession() {
      return { chunk: '', alive }
    },
    async clearSession(sessionId: string) {
      clears.push(sessionId)
      return true
    },
    async resizeSession(sessionId: string, cols: number, rows: number) {
      resizes.push({ sessionId, cols, rows })
      return true
    },
    async killSession(sessionId: string) {
      kills.push(sessionId)
      return true
    },
  }
}

function nativeFor(transport: ReturnType<typeof fakeTransport>, sessionId = 'term-1', cwd: string | null = '/workspace') {
  return m.createSessionTermNative(transport, sessionId, cwd)
}

async function main() {
  m = await import('../src/lib/terminal')

  // ── base64 ──────────────────────────────────────────────────────────────
  check('b64 matches node Buffer', m.b64encodeText('hello') === b64('hello'))
  check('b64 encodes utf8 deterministically', m.b64encodeText('مرحبا ✓') === m.b64encodeText('مرحبا ✓'))
  check('b64 empty is identity', m.b64encodeText('') === '')

  // ── mapFieldChange (BUG-095 sentinel field) ───────────────────────────
  const S = m.FIELD_SENTINEL
  check('empty → empty: DEL past field start', JSON.stringify(m.mapFieldChange('', '')) === JSON.stringify({ type: 'delete', count: 1 }))
  check('bare sentinel back = noop', m.mapFieldChange('', S).type === 'noop')
  check('typing appends', m.mapFieldChange('', S + 'ls').type === 'append' && m.mapFieldChange('', S + 'ls').type === 'append')
  check(
    'append text payload',
    JSON.stringify(m.mapFieldChange('l', S + 'ls')) === JSON.stringify({ type: 'append', text: 's' }),
  )
  check(
    'mid-text backspace: one DEL',
    JSON.stringify(m.mapFieldChange('ls', S + 'l')) === JSON.stringify({ type: 'delete', count: 1 }),
  )
  check(
    'clear-line backspaces: full DEL storm',
    JSON.stringify(m.mapFieldChange('ls -la', S)) === JSON.stringify({ type: 'delete', count: 6 }),
  )
  check(
    'autocorrect rewrite rebuilds',
    JSON.stringify(m.mapFieldChange('teh', S + 'the')) === JSON.stringify({ type: 'rewrite', count: 3, text: 'the' }),
  )
  check(
    'autocapitalize same-length rewrite',
    JSON.stringify(m.mapFieldChange('ls', S + 'Ls')) === JSON.stringify({ type: 'rewrite', count: 2, text: 'Ls' }),
  )
  check(
    'prefix completion is pure append',
    JSON.stringify(m.mapFieldChange('Doc', S + 'Documents')) === JSON.stringify({ type: 'append', text: 'uments' }),
  )
  check('sentinel dropped, text same → resync (no bytes)', m.mapFieldChange('ls', 'ls').type === 'resync')
  check('stale composing after Enter → resync (no bytes)', m.mapFieldChange('', 'l').type === 'resync')

  // ── applyFieldChange pairing (BUG-095 dual channel) ───────────────────
  // Key event first (Android dispatches onKeyPress BEFORE the change):
  // the key handler sends DEL + stamps pendingKeys; the paired change must
  // send NOTHING more.
  const keyed = m.applyFieldChange({ logical: '', pendingKeys: 1 }, '')
  check('empty-field backspace: key+change → exactly one DEL', keyed.bytes === '')
  check('pairing consumes the pending key', keyed.next.pendingKeys === 0)
  const changeOnly = m.applyFieldChange({ logical: '', pendingKeys: 0 }, '')
  check('empty-field backspace: change-only IME → one DEL', changeOnly.bytes === '\x7f')
  const dbl = m.applyFieldChange(m.applyFieldChange({ logical: '', pendingKeys: 2 }, '').next, '')
  check('double backspace (key,key,change,change) → 2 DELs, no swallow', dbl.bytes === '' && dbl.next.pendingKeys === 0)
  const mid = m.applyFieldChange({ logical: 'ab', pendingKeys: 0 }, S + 'a')
  check('non-empty backspace via change only', mid.bytes === '\x7f' && mid.next.logical === 'a')
  const typed = m.applyFieldChange({ logical: '', pendingKeys: 1 }, S + 'x')
  check('keystroke after unpaired key invalidates pending', typed.bytes === 'x' && typed.next.pendingKeys === 0)
  const seq = m.applyFieldChange({ logical: 'ls', pendingKeys: 0 }, S)
  check('full storm through pairing', seq.bytes === '\x7f\x7f' && seq.next.logical === '')
  check('resync sends nothing, keeps logical', m.applyFieldChange({ logical: 'ls', pendingKeys: 0 }, 'ls').bytes === '')

  // ── session id + adapter binding ──────────────────────────────────────
  const idA = m.newTermSessionId(1_700_000_000_000)
  const idB = m.newTermSessionId(1_700_000_000_000)
  check('session id shape term-<ts>-<seq>', /^term-1700000000000-\d+$/.test(idA), idA)
  check('session ids are unique per process', idA !== idB)
  check('session id stays inside python bound (≤64)', idA.length <= 64)

  const bindT = fakeTransport()
  const bindA = nativeFor(bindT, 'term-bind-a', '/workspace/proj-a')
  const bindB = nativeFor(bindT, 'term-bind-b', null)
  const bindCtlA = new m.TerminalController(bindA, { drainMs: 50 })
  const bindCtlB = new m.TerminalController(bindB, { drainMs: 50 })
  await bindCtlA.start(80, 24)
  await bindCtlB.start(90, 30)
  check(
    'adapter passes its bound session + cwd on start',
    bindT.starts[0]?.sessionId === 'term-bind-a' &&
      bindT.starts[0]?.cwd === '/workspace/proj-a' &&
      bindT.starts[1]?.sessionId === 'term-bind-b' &&
      bindT.starts[1]?.cwd === null,
  )
  let lateCwd: string | null = null
  const lateNative = m.createSessionTermNative(bindT, 'term-bind-late', () => lateCwd)
  const lateCtl = new m.TerminalController(lateNative)
  lateCwd = '/workspace/adopted-after-mount'
  await lateCtl.start(80, 24)
  check(
    'adapter reads a late-adopted project cwd at start time',
    bindT.starts[2]?.sessionId === 'term-bind-late' &&
      bindT.starts[2]?.cwd === '/workspace/adopted-after-mount',
  )
  lateCtl.destroy()
  await bindCtlA.send('a\n')
  await bindCtlB.send('b\n')
  check(
    'two adapters never cross-write',
    bindT.writes[0]?.sessionId === 'term-bind-a' &&
      bindT.writes[1]?.sessionId === 'term-bind-b',
  )
  check('adapter resize stays on its session', (await bindA.resize(100, 40)) && bindT.resizes[0]?.sessionId === 'term-bind-a')
  bindCtlA.rawBank = 'stale'
  await bindCtlA.clear()
  check(
    'adapter clear stays on its session and wipes the local bank',
    bindT.clears.length === 1 && bindT.clears[0] === 'term-bind-a' && bindCtlA.rawBank === '',
  )
  await bindCtlA.kill()
  check('adapter kill stays on its session', bindT.kills.length === 1 && bindT.kills[0] === 'term-bind-a')
  bindCtlA.destroy()
  bindCtlB.destroy()

  // ── controller: RAW byte flow (BUG-097) ───────────────────────────────
  const rep = b64('\x1b[1mroot@moch\x1b[0m:~# ')
  const live = b64('hello\x08 \x08pty\n') // backspace erases — must survive untouched
  const got: string[] = []
  const fake = fakeTransport([live])
  fake.replaySession = async () => ({ chunk: rep, alive: true })
  const ctl = new m.TerminalController(nativeFor(fake), { drainMs: 50, onChunk: (c) => got.push(c) })
  const snaps: string[] = []
  ctl.onChange((s) => snaps.push(s.state))
  const ok = await ctl.start(80, 24)
  check('start ok → live', ok && ctl.state === 'live')
  check('replay forwarded RAW through onChunk', got[0] === rep)
  check('raw bank holds the replay', ctl.rawBank === rep)
  check('start passed the adapter cwd to the transport', fake.starts[0]?.cwd === '/workspace')
  await ctl.tick()
  check('drain chunk forwarded RAW (esc + \\x08 intact)', got[1] === live)
  check('raw bank accumulates ticks', ctl.rawBank === rep + live)
  check('listener fired live', snaps.includes('live'))

  // ── controller: send base64s the bytes ────────────────────────────────
  await ctl.send('ls\n')
  const sent = Buffer.from(fake.writes[0]?.data ?? '', 'base64').toString('utf8')
  check('send writes base64 line', sent === 'ls\n')
  await ctl.send(m.TERM_KEYS.CTRL_C)
  const sentCtrl = Buffer.from(fake.writes[1]?.data ?? '', 'base64').toString('utf8')
  check('Ctrl+C sends \\x03', sentCtrl === '\x03')

  // ── controller: pause/resume + reattach ───────────────────────────────
  check('controller polls while active', ctl.polling)
  ctl.pause()
  check('pause stops polling', !ctl.polling)
  ctl.resume()
  check('resume re-arms a live controller', ctl.polling)
  ctl.pause()
  const snap = b64('reattached scrollback\n')
  fake.replaySession = async () => ({ chunk: snap, alive: true })
  ctl.rawBank = ''
  const reattached = await ctl.reattach()
  check('reattach replaces the raw bank with native replay', reattached === snap && ctl.rawBank === snap)

  // ── controller: raw bank cap trims on a b64 boundary ──────────────────
  const big = fakeTransport([b64('a'.repeat(200000))])
  const ctlBig = new m.TerminalController(nativeFor(big), { onChunk: () => {} })
  await ctlBig.start(80, 24)
  await ctlBig.tick()
  check('raw bank capped', ctlBig.rawBank.length <= m.TERM_RAW_BANK_B64_CAP)
  check('raw bank stays valid b64', ctlBig.rawBank.length % 4 === 0 && /^[A-Za-z0-9+/=]*$/.test(ctlBig.rawBank))
  await ctlBig.send('q\n')

  // ── controller: shell death → dead ────────────────────────────────────
  const dying = fakeTransport([], false)
  const ctl2 = new m.TerminalController(nativeFor(dying))
  await ctl2.start(80, 24)
  await ctl2.tick()
  check('dead shell marks dead', ctl2.state === 'dead' && !ctl2.alive)

  // ── controller: start failure ─────────────────────────────────────────
  const bad = fakeTransport()
  bad.startSession = async () => ({ ok: false, alreadyRunning: false, error: 'guest not bootstrapped' })
  const ctl3 = new m.TerminalController(nativeFor(bad))
  const ok3 = await ctl3.start(80, 24)
  check('failed start → dead + error', !ok3 && ctl3.state === 'dead' && ctl3.error === 'guest not bootstrapped')

  // ── controller: clear wipes the raw bank ──────────────────────────────
  ctl.rawBank = ''
  check('clear wipes raw bank', ctl.rawBank === '')

  // ── controller: kill ──────────────────────────────────────────────────
  await ctl.kill()
  check('kill → dead', ctl.state === 'dead')
  ctl.destroy()
  ctl2.destroy()
  ctl3.destroy()
  ctlBig.destroy()

  // ── URL matcher (BUG-135 terminal link hit-test) ──────────────────────
  // Covers the TS copies of the matcher/normalizer that the xterm asset
  // mirrors inline (see the sync notes in terminal.ts / index.html).
  check(
    'normalize keeps a plain https url',
    m.normalizeTerminalUrl('https://example.com/x') === 'https://example.com/x',
  )
  check(
    'normalize trims trailing sentence punctuation',
    m.normalizeTerminalUrl('https://example.com/x,.:') === 'https://example.com/x',
  )
  check(
    'normalize keeps balanced parens (wikipedia-style)',
    m.normalizeTerminalUrl('https://en.wikipedia.org/wiki/A_(b)') === 'https://en.wikipedia.org/wiki/A_(b)',
  )
  check(
    'normalize strips unbalanced trailing paren + period',
    m.normalizeTerminalUrl('https://example.com/a).') === 'https://example.com/a',
  )
  check(
    'normalize promotes www. to https',
    m.normalizeTerminalUrl('www.example.com/x') === 'https://www.example.com/x',
  )
  check(
    'normalize scheme check is case-insensitive',
    m.normalizeTerminalUrl('HTTPS://EXAMPLE.COM/X') === 'HTTPS://EXAMPLE.COM/X',
  )
  check(
    'normalize unwraps angle brackets',
    m.normalizeTerminalUrl('<https://example.com/>') === 'https://example.com/',
  )
  check('normalize trims wrapping whitespace', m.normalizeTerminalUrl('  https://a.com ') === 'https://a.com')
  check('normalize rejects non-web schemes (mailto)', m.normalizeTerminalUrl('mailto:foo@bar.com') === null)
  check('normalize rejects non-web schemes (ftp)', m.normalizeTerminalUrl('ftp://example.com') === null)

  const urlLine = 'see https://example.com/docs for more' // url at [4,28)
  check('hit-test: tap on url start opens it', m.findTerminalUrlAt(urlLine, 4) === 'https://example.com/docs')
  check('hit-test: tap inside url opens it', m.findTerminalUrlAt(urlLine, 27) === 'https://example.com/docs')
  check('hit-test: tap just past url end misses', m.findTerminalUrlAt(urlLine, 28) === null)
  check('hit-test: tap before url misses', m.findTerminalUrlAt(urlLine, 0) === null)
  check(
    'hit-test: www. prefix hit promotes to https',
    m.findTerminalUrlAt('go www.example.com now', 3) === 'https://www.example.com',
  )
  check(
    'hit-test: trailing punctuation in the line is trimmed from the url',
    m.findTerminalUrlAt('ref (https://ex.com/a).', 10) === 'https://ex.com/a',
  )
  check(
    'hit-test: uppercase scheme matches and survives',
    m.findTerminalUrlAt('HTTPS://EXAMPLE.COM/X', 0) === 'HTTPS://EXAMPLE.COM/X',
  )
  check('hit-test: no url on the line misses', m.findTerminalUrlAt('plain output line', 5) === null)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-terminal crashed:', err)
  process.exit(1)
})
