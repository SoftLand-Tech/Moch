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
  check('b64 round-trip ascii', m.b64decodeText(m.b64encodeText('ls -la ~/x')) === 'ls -la ~/x')
  check(
    'b64 round-trip utf8',
    m.b64decodeText(m.b64encodeText('مرحبا terminal ✓')) === 'مرحبا terminal ✓',
  )
  check('b64 matches node Buffer', m.b64encodeText('hello') === b64('hello'))
  check('b64decodeText tolerates binary', m.b64decodeText('////').length > 0)

  // ── stripAnsi ─────────────────────────────────────────────────────────
  check(
    'CSI color stripped',
    m.stripAnsi('\x1b[32mgreen\x1b[0m plain') === 'green plain',
  )
  check(
    'cursor moves stripped',
    m.stripAnsi('a\x1b[2Kb\x1b[1A') === 'ab',
  )
  check('CRLF → LF', m.stripAnsi('one\r\ntwo\ragain') === 'one\ntwo\nagain')
  check('OSC title stripped', m.stripAnsi('\x1b]0;title\x07after') === 'after')

  // ── appendCapped ──────────────────────────────────────────────────────
  check('append joins', m.appendCapped('ab', 'cd') === 'abcd')
  const capped = m.appendCapped('x'.repeat(100), 'y'.repeat(100), 150)
  check('cap keeps the tail', capped.length === 150 && capped.endsWith('y'.repeat(100)))
  check('empty add is identity', m.appendCapped('ab', '') === 'ab')

  // ── controller: start banks replay + tick banks drain ─────────────────
  const rep = b64('\x1b[1mroot@moch\x1b[0m:~# ')
  const live = b64('hello-pty\n')
  const fake = fakeNative([live])
  fake.replay = async () => ({ chunk: rep, alive: true })
  const ctl = new m.TerminalController(fake)
  const snaps: string[] = []
  ctl.onChange((s) => snaps.push(s.state))
  const ok = await ctl.start(80, 24)
  check('start ok → live', ok && ctl.state === 'live')
  check('replay painted without ANSI', ctl.text === 'root@moch:~# ')
  await ctl.tick()
  check('drain appended', ctl.text.endsWith('hello-pty\n'))
  check('listener fired live', snaps.includes('live'))

  // ── controller: send base64s the bytes ────────────────────────────────
  await ctl.send('ls\n')
  const sent = Buffer.from(fake.writes[0] ?? '', 'base64').toString('utf8')
  check('send writes base64 line', sent === 'ls\n')
  await ctl.send(m.TERM_KEYS.CTRL_C)
  const sentCtrl = Buffer.from(fake.writes[1] ?? '', 'base64').toString('utf8')
  check('Ctrl+C sends \\x03', sentCtrl === '\x03')

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

  // ── controller: kill ──────────────────────────────────────────────────
  await ctl.kill()
  check('kill → dead', ctl.state === 'dead')
  ctl.destroy()
  ctl2.destroy()
  ctl3.destroy()

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
