// OpenCode `All sessions` default pick: validation + one-shot fallback. Pure.
export {}
type Mod = typeof import('../src/lib/ocDefaultPick')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  const m: Mod = await import('../src/lib/ocDefaultPick')

  // ── parseOcDefaultPick ──────────────────────────────────────────────────
  const stored = JSON.stringify({ providerID: 'openrouter', modelID: 'anthropic/claude-sonnet', id: 'claude-sonnet' })
  const parsed = m.parseOcDefaultPick(stored)
  check('stored JSON parses', parsed?.providerID === 'openrouter' && parsed.modelID === 'anthropic/claude-sonnet' && parsed.id === 'claude-sonnet')
  check('object parses too', m.parseOcDefaultPick({ providerID: 'p', modelID: 'm', id: 'm' })?.id === 'm')
  check('missing id falls back to bare modelID', m.parseOcDefaultPick({ providerID: 'p', modelID: 'm' })?.id === 'm')
  check('whitespace is trimmed', m.parseOcDefaultPick({ providerID: ' p ', modelID: ' m ', id: ' m ' })?.providerID === 'p')
  check('invalid JSON → null', m.parseOcDefaultPick('{nope') === null)
  check('empty string → null', m.parseOcDefaultPick('   ') === null)
  check('null → null', m.parseOcDefaultPick(null) === null)
  check('array → null', m.parseOcDefaultPick([{ providerID: 'p', modelID: 'm' }]) === null)
  check('missing provider → null', m.parseOcDefaultPick({ modelID: 'm' }) === null)
  check('missing model → null', m.parseOcDefaultPick({ providerID: 'p' }) === null)
  check('empty provider → null', m.parseOcDefaultPick({ providerID: '  ', modelID: 'm' }) === null)
  check('oversized part → null', m.parseOcDefaultPick({ providerID: 'p', modelID: 'm'.repeat(201) }) === null)

  // ── provider/model refs + one-shot fallback ─────────────────────────────
  const def = { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet', id: 'claude-sonnet' }
  check('default ref is provider/model', m.ocDefaultPickModelRef(def) === 'openrouter/anthropic/claude-sonnet')
  check('no default ref → null', m.ocDefaultPickModelRef(null) === null)
  check('chat pick wins over default', m.ocOneShotModelRef('openai/gpt-5', def) === 'openai/gpt-5')
  check('default used when chat never picked', m.ocOneShotModelRef(null, def) === 'openrouter/anthropic/claude-sonnet')
  check('empty chat pick falls back to default', m.ocOneShotModelRef('   ', def) === 'openrouter/anthropic/claude-sonnet')
  check('no chat pick + no default → null', m.ocOneShotModelRef(undefined, null) === null)

  console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

void main()
