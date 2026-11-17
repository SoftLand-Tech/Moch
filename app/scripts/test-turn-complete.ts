// Unit tests for the BUG-130 terminal-completion gate (no gateway, no RN):
// `isTerminalComplete` must distinguish a genuinely terminal
// `message.complete` payload from the subagent mirror's text-only mid-turn
// update, for every emission site the gateway has.
//
// Shape reference — app/hermes-src/tui_gateway/contracts/events.py
// `MessageCompletePayload` and its four emitters:
//   real turn end       → usage (dict) + status
//   auto-continue error → usage + status:"error"
//   compute-host end    → text + status:"error"
//   subagent mirror     → text ONLY (no usage, no status)

import { isTerminalComplete } from '../src/lib/turnComplete'

// Payloads on the wire carry the full MessageCompletePayload field set; the
// helper deliberately takes only the structural slice it needs, so test
// payloads are typed as records to avoid excess-property literals.
const payload = (o: Record<string, unknown>) => o

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function main() {
  // ── Terminal payloads: every non-mirror emitter ──────────────────────────
  check(
    'real turn end (usage + status) is terminal',
    isTerminalComplete(payload({ text: 'done', usage: { total_tokens: 42 }, status: 'ok' })) === true,
  )
  check(
    'auto-continue terminal error (usage + status:"error") is terminal',
    isTerminalComplete(payload({ text: '', usage: { total_tokens: 0 }, status: 'error', error: 'loop stalled' })) === true,
  )
  check(
    'compute-host end (text + status:"error") is terminal',
    isTerminalComplete(payload({ text: 'host died', status: 'error' })) === true,
  )
  check('status-only payload is terminal', isTerminalComplete(payload({ status: 'ok' })) === true)
  check('usage-only payload is terminal', isTerminalComplete(payload({ usage: { total_tokens: 1 } })) === true)

  // ── Non-terminal: the subagent mirror ────────────────────────────────────
  check('subagent mirror (text only) is NOT terminal', isTerminalComplete(payload({ text: 'child said hi' })) === false)
  check('empty payload is NOT terminal', isTerminalComplete(payload({})) === false)

  // ── Contract extras: reasoning/warning are optional fields on the SAME
  //    payload type — they never make a payload terminal by themselves, and
  //    they don't mask the discriminator when the real emitters add them.
  check('reasoning alone is NOT terminal', isTerminalComplete(payload({ text: 'x', reasoning: 'thinking…' })) === false)
  check('warning alone is NOT terminal', isTerminalComplete(payload({ text: 'x', warning: 'slow' })) === false)
  check(
    'real end + reasoning/warning extras is terminal',
    isTerminalComplete(payload({ text: 'done', usage: {}, status: 'ok', reasoning: 'r', warning: 'w' })) === true,
  )

  // ── Mirrors can be fat: a mirror may still carry reasoning/warning/error
  //    fields — only usage/status presence ends the turn.
  check('mirror with reasoning/warning is NOT terminal', isTerminalComplete(payload({ text: 'x', reasoning: 'r', warning: 'w' })) === false)

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
