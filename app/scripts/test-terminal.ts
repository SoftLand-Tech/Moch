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

function fakeNative(outChunks: string[] = [], alive = true) {
  const writes: string[] = []
  return {
    writes,
    async start() {
      return { ok: true, alreadyRunning: false }
    },
    async write(d: string) {
      writes.push(d)
      return true
    },
    async drain() {
      const c = outChunks.splice(0, outChunks.length)
      return { chunks: c, alive }
    },
    async replay() {
      return { chunk: '', alive }
    },
    async resize() {
      return true
    },
    async kill() {
      return true
    },
  }
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

  // ── controller: RAW byte flow (BUG-097) ───────────────────────────────
  const rep = b64('\x1b[1mroot@moch\x1b[0m:~# ')
  const live = b64('hello\x08 \x08pty\n') // backspace erases — must survive untouched
  const got: string[] = []
  const fake = fakeNative([live])
  fake.replay = async () => ({ chunk: rep, alive: true })
  const ctl = new m.TerminalController(fake, { drainMs: 50, onChunk: (c) => got.push(c) })
  const snaps: string[] = []
  ctl.onChange((s) => snaps.push(s.state))
  const ok = await ctl.start(80, 24)
  check('start ok → live', ok && ctl.state === 'live')
  check('replay forwarded RAW through onChunk', got[0] === rep)
  check('raw bank holds the replay', ctl.rawBank === rep)
  await ctl.tick()
  check('drain chunk forwarded RAW (esc + \\x08 intact)', got[1] === live)
  check('raw bank accumulates ticks', ctl.rawBank === rep + live)
  check('listener fired live', snaps.includes('live'))

  // ── controller: send base64s the bytes ────────────────────────────────
  await ctl.send('ls\n')
  const sent = Buffer.from(fake.writes[0] ?? '', 'base64').toString('utf8')
  check('send writes base64 line', sent === 'ls\n')
  await ctl.send(m.TERM_KEYS.CTRL_C)
  const sentCtrl = Buffer.from(fake.writes[1] ?? '', 'base64').toString('utf8')
  check('Ctrl+C sends \\x03', sentCtrl === '\x03')

  // ── controller: raw bank cap trims on a b64 boundary ──────────────────
  const big = fakeNative([b64('a'.repeat(200000))])
  const ctlBig = new m.TerminalController(big, { onChunk: () => {} })
  await ctlBig.start(80, 24)
  await ctlBig.tick()
  check('raw bank capped', ctlBig.rawBank.length <= m.TERM_RAW_BANK_B64_CAP)
  check('raw bank stays valid b64', ctlBig.rawBank.length % 4 === 0 && /^[A-Za-z0-9+/=]*$/.test(ctlBig.rawBank))
  await ctlBig.send('q\n')

  // ── controller: shell death → dead ────────────────────────────────────
  const dying = fakeNative([], false)
  const ctl2 = new m.TerminalController(dying)
  await ctl2.start(80, 24)
  await ctl2.tick()
  check('dead shell marks dead', ctl2.state === 'dead' && !ctl2.alive)

  // ── controller: start failure ─────────────────────────────────────────
  const bad = fakeNative()
  bad.start = async () => ({ ok: false, alreadyRunning: false, error: 'guest not bootstrapped' })
  const ctl3 = new m.TerminalController(bad)
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
