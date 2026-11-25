// Unit tests for OpenCode long-generation / tool-call watchdog & reconnect
// policy (no RN / AsyncStorage imports).
//
// Run: cd app && npx tsx scripts/test-oc-turn.ts

import {
  OC_IDLE_SILENCE_MS,
  OC_MAX_RECONNECT_ATTEMPTS,
  OC_RECONNECT_MAX_MS,
  OC_TOOL_SILENCE_MS,
  computeOcSilenceLimitMs,
  decideOcDisconnectAction,
  ocReconnectDelayMs,
} from '../src/lib/ocTurnWatchdog'
import { findOcTurnAssistant } from '../src/lib/ocHistory'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function main() {
  // ── Silence budget computation ──────────────────────────────────────────
  const idleLimit = computeOcSilenceLimitMs({
    awaitingUserCount: 0,
    activeToolCount: 0,
    compacting: false,
  })
  check(
    'idle / between-step gap allows >= 180s instead of 15s',
    idleLimit === OC_IDLE_SILENCE_MS && idleLimit >= 180_000,
    String(idleLimit),
  )

  const toolLimit = computeOcSilenceLimitMs({
    awaitingUserCount: 0,
    activeToolCount: 1,
    compacting: false,
  })
  check(
    'in-flight tool generation/execution allows >= 600s',
    toolLimit === OC_TOOL_SILENCE_MS && toolLimit >= 600_000,
    String(toolLimit),
  )

  const compactLimit = computeOcSilenceLimitMs({
    awaitingUserCount: 0,
    activeToolCount: 0,
    compacting: true,
  })
  check('compaction gets extended tool patience', compactLimit === OC_TOOL_SILENCE_MS, String(compactLimit))

  const retryLimit = computeOcSilenceLimitMs({
    awaitingUserCount: 0,
    activeToolCount: 0,
    compacting: false,
    nowMs: 1_000_000,
    retryAtMs: 1_300_000, // retry 5m from now
  })
  check(
    'scheduled retry extends patience beyond retry deadline',
    retryLimit !== null && retryLimit >= 480_000,
    String(retryLimit),
  )

  const pausedLimit = computeOcSilenceLimitMs({
    awaitingUserCount: 1,
    activeToolCount: 0,
    compacting: false,
  })
  check('interactive permission/question pauses silence watchdog', pausedLimit === null, String(pausedLimit))

  // ── Probe & reconnect decisions ─────────────────────────────────────────
  const dRunningSilent = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'silent',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: true,
    rebindCount: 0,
  })
  check(
    'silent timeout while OpenCode session still running reconnects SSE',
    dRunningSilent.kind === 'reconnect' && dRunningSilent.reason === 'server-running' && dRunningSilent.countRebind,
  )

  const dRunningDropped = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'dropped',
    hasActivity: true,
    lastSilenceLimitMs: OC_TOOL_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: true,
    rebindCount: 2,
  })
  check(
    'dropped SSE while OpenCode session still running reconnects and counts toward the attempt cap',
    dRunningDropped.kind === 'reconnect' && dRunningDropped.countRebind,
  )

  const dPendingForm = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'silent',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 1,
    sessionActive: false,
    rebindCount: 0,
  })
  check(
    'pending question form forces SSE reconnect',
    dPendingForm.kind === 'reconnect' && dPendingForm.reason === 'awaiting-form' && dPendingForm.countRebind,
  )

  const dSucceededOnServer = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'dropped',
    hasActivity: true,
    lastSilenceLimitMs: OC_TOOL_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: false,
    sessionOutcome: 'succeeded',
    sessionIdle: true,
    rebindCount: 0,
  })
  check(
    'server finished with succeeded outcome while SSE dropped completes & syncs history',
    dSucceededOnServer.kind === 'complete' && !dSucceededOnServer.failed && dSucceededOnServer.syncHistory,
  )

  const dFailedOnServer = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'dropped',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: false,
    sessionOutcome: 'failed',
    sessionIdle: true,
    rebindCount: 0,
    existingError: 'Upstream rate limit',
  })
  check(
    'server finished with failed outcome reports honest error',
    dFailedOnServer.kind === 'fail' && dFailedOnServer.message === 'Upstream rate limit',
  )

  const dTooManySilentRebinds = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'silent',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: true,
    rebindCount: OC_MAX_RECONNECT_ATTEMPTS,
  })
  check(
    'exceeding max reconnect attempts fails honestly instead of looping forever',
    dTooManySilentRebinds.kind === 'fail' && /stopped responding/i.test(dTooManySilentRebinds.message),
  )

  const dUnknownProbeStaleOutcome = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'dropped',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: null,
    sessionOutcome: 'succeeded',
    sessionIdle: true,
    rebindCount: 0,
  })
  check(
    'failed active probe never trusts a stale succeeded outcome from the previous turn',
    dUnknownProbeStaleOutcome.kind === 'reconnect' && dUnknownProbeStaleOutcome.reason === 'server-probe-unknown',
  )

  const dDroppedAtCap = decideOcDisconnectAction({
    cancelled: false,
    turnDone: false,
    winner: 'dropped',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: true,
    rebindCount: OC_MAX_RECONNECT_ATTEMPTS,
  })
  check(
    'repeated dropped SSE legs stop at the reconnect cap',
    dDroppedAtCap.kind === 'fail',
  )

  check('reconnect backoff grows and caps', ocReconnectDelayMs(0) === 250 && ocReconnectDelayMs(3) === 2_000 && ocReconnectDelayMs(99) === OC_RECONNECT_MAX_MS)

  const dCancelled = decideOcDisconnectAction({
    cancelled: true,
    turnDone: false,
    winner: 'silent',
    hasActivity: true,
    lastSilenceLimitMs: OC_IDLE_SILENCE_MS,
    pendingFormCount: 0,
    sessionActive: true,
    rebindCount: 0,
  })
  check(
    'user cancel stops cleanly without failure',
    dCancelled.kind === 'complete' && !dCancelled.failed && !dCancelled.syncHistory,
  )

  const turnRows = [
    { role: 'user' as const, text: 'old prompt', ts: 1 },
    { role: 'assistant' as const, text: 'old answer', ts: 2 },
    { role: 'user' as const, text: 'new prompt', ts: 3 },
    { role: 'assistant' as const, text: 'new answer', ts: 4 },
  ]
  check(
    'history catch-up selects the assistant owned by the current prompt',
    findOcTurnAssistant(turnRows, 'new prompt')?.text === 'new answer',
  )
  check(
    'history catch-up never borrows the previous turn answer for an empty new turn',
    findOcTurnAssistant([
      { role: 'user', text: 'old prompt', ts: 1 },
      { role: 'assistant', text: 'old answer', ts: 2 },
      { role: 'user', text: 'new prompt', ts: 3 },
    ], 'new prompt') === undefined,
  )
  check(
    'history catch-up rejects an older identical prompt outside the current turn boundary',
    findOcTurnAssistant([
      { role: 'user', text: 'same', ts: 1 },
      { role: 'assistant', text: 'old answer', ts: 2 },
    ], 'same', 5_000) === undefined,
  )
  check(
    'command catch-up falls back to the expanded prompt at the turn boundary',
    findOcTurnAssistant([
      { role: 'user', text: 'Review src/auth.ts for bugs', ts: 5_100 },
      { role: 'assistant', text: 'command answer', ts: 5_200 },
    ], 'src/auth.ts', 5_000)?.text === 'command answer',
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main()
