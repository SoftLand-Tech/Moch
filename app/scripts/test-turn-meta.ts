// Unit tests for lib/turnMeta (2026-10-14 UI revamp) — parsing/formatting the
// per-turn provenance the gateway has always sent on message.complete and the
// app used to drop. Pure module: no gateway, no RN, no stores.
// (Module-scoped on purpose: the scripts tsconfig compiles every test into
// one program, and global `pass`/`check` helpers would collide.)
export {}
type TurnMetaMod = typeof import('../src/lib/turnMeta')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  const t: TurnMetaMod = await import('../src/lib/turnMeta')

  // ── parseTurnUsage ────────────────────────────────────────────────────────
  check('undefined payload → undefined', t.parseTurnUsage(undefined) === undefined)
  check('null payload → undefined', t.parseTurnUsage(null) === undefined)
  check('non-object payload → undefined', t.parseTurnUsage('many tokens') === undefined)
  check('empty object → undefined (no footer for nothing)', t.parseTurnUsage({}) === undefined)
  check('zero counts with a model keep a model-only footer', t.parseTurnUsage({ model: 'm', total: 0, output: 0, avg_tps: 0 })?.model === 'm')
  check('zero counts without a model → undefined', t.parseTurnUsage({ total: 0, output: 0, avg_tps: 0 }) === undefined)

  const full = t.parseTurnUsage({ model: 'glm-5.3', input: 456, output: 789, total: 1245, avg_tps: 31.4 })
  check('full payload parses', full?.model === 'glm-5.3' && full?.totalTokens === 1245 && full?.tps === 31.4)

  const bare = t.parseTurnUsage({ output: 42 })
  check('bare output count still earns a footer', bare?.totalTokens === 42)

  const malformed = t.parseTurnUsage({ model: 123, total: 'lots', avg_tps: 'fast' })
  check('wrong-typed fields are dropped, not thrown', malformed === undefined)

  const negative = t.parseTurnUsage({ total: -5, avg_tps: -1 })
  check('negative counts are ignored', negative === undefined)

  // ── formatTurnMeta ────────────────────────────────────────────────────────
  check('undefined → empty string', t.formatTurnMeta(undefined) === '')
  check('{} → empty string', t.formatTurnMeta({}) === '')
  check('model only', t.formatTurnMeta({ model: 'gpt-x' }) === 'gpt-x')
  check('tokens under 1k stay exact', t.formatTurnMeta({ totalTokens: 42 }) === '42 tok')
  check('1.2k keeps one decimal', t.formatTurnMeta({ totalTokens: 1234 }) === '1.2k tok')
  check('12k rounds to integer', t.formatTurnMeta({ totalTokens: 12345 }) === '12k tok')
  check('tps rounds', t.formatTurnMeta({ tps: 31.6 }) === '32 t/s')
  check(
    'full footer joins with · in order model · tok · tps',
    t.formatTurnMeta({ model: 'glm-5.3', totalTokens: 1234, tps: 31.4 }) === 'glm-5.3 · 1.2k tok · 31 t/s',
  )
  check('zero tokens render no tok segment', t.formatTurnMeta({ model: 'm', tps: 10 }) === 'm · 10 t/s')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
