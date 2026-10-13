// Unit tests for src/lib/chatScroll.ts — the stick-to-bottom / follow policy
// of the chat transcript (BUG-102/103, tracker BH-000031), extracted from
// chat.tsx so the POLICY is pinnable offline. The list is inverted: y=0 is
// the visual bottom (newest message) and y grows toward older history.
//
// What this deliberately does NOT cover: chip placement inside the streamed
// bubble (BUG-102 markup) and the actual animated jumps — those stay
// device-verified; chat.tsx keeps the refs/timers glue.
type CS = typeof import('../src/lib/chatScroll')

let cs: CS

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  cs = await import('../src/lib/chatScroll')
  const { evaluateStick, shouldFollowOnAppend, contentGrew, STICK_BAND_PX } = cs

  // ── evaluateStick: the pin verdict ──────────────────────────────────────
  check('pinned at the bottom edge (y=0): stick, no FAB', (() => {
    const v = evaluateStick({ y: 0, contentH: 4000, viewH: 800 })
    return v?.stick === true && v?.showJump === false
  })())
  check('slight drift inside the 120px band still counts as pinned', (() => {
    const v = evaluateStick({ y: STICK_BAND_PX - 1, contentH: 4000, viewH: 800 })
    return v?.stick === true && v?.showJump === false
  })())
  check('user scrolled up past the band: unpin + jump FAB', (() => {
    const v = evaluateStick({ y: STICK_BAND_PX + 1, contentH: 4000, viewH: 800 })
    return v?.stick === false && v?.showJump === true
  })())
  check('overscroll (negative y, bounce past the bottom) clamps to pinned', (() => {
    const v = evaluateStick({ y: -80, contentH: 4000, viewH: 800 })
    return v?.stick === true
  })())
  check('a short chat that FITS the viewport is always pinned (cannot scroll away)', (() => {
    const v = evaluateStick({ y: 500, contentH: 300, viewH: 800 })
    return v?.stick === true && v?.showJump === false
  })())
  check('no layout yet (viewH=0): no verdict — callers hold their previous state', evaluateStick({ y: 999, contentH: 0, viewH: 0 }) === null)

  // ── shouldFollowOnAppend: follow-on-append ──────────────────────────────
  check('follows an append when pinned but drifted (y>0)', shouldFollowOnAppend({ y: 50 }, { stick: true, quietWindow: false }) === true)
  check('does NOT follow when the user scrolled up (unpinned)', shouldFollowOnAppend({ y: 900 }, { stick: false, quietWindow: false }) === false)
  check('does NOT follow while a programmatic jump is mid-flight (quiet window)', shouldFollowOnAppend({ y: 50 }, { stick: true, quietWindow: true }) === false)
  check('does NOT follow at exactly y=0 — new content grows from the bottom edge natively', shouldFollowOnAppend({ y: 0 }, { stick: true, quietWindow: false }) === false)

  // ── contentGrew: streaming deltas / row mounts ──────────────────────────
  check('streaming delta while pinned at the edge: hold (native growth, no jump call)', contentGrew({ y: 0 }, true) === 'hold')
  check('streaming delta while pinned but drifted: pull back to the bottom', contentGrew({ y: 40 }, true) === 'follow')
  check('content grew while the user reads history: only re-evaluate, never yank', contentGrew({ y: 1500 }, false) === 'reevaluate')

  // ── keyboard lift ───────────────────────────────────────────────────────
  // The IME shrinks viewH (edge-to-edge: the OS never resizes the window).
  // Pinned stays pinned: the composer pads up by the keyboard height and the
  // offset-0 edge travels with it.
  check('keyboard lift while pinned: still pinned at the bottom', (() => {
    const before = evaluateStick({ y: 0, contentH: 2000, viewH: 800 })
    const after = evaluateStick({ y: 0, contentH: 2000, viewH: 800 - 300 })
    return before?.stick === true && after?.stick === true
  })())
  check('keyboard lift while reading history: still unpinned (no yank to bottom)', (() => {
    const after = evaluateStick({ y: 1200, contentH: 4000, viewH: 800 - 300 })
    return after?.stick === false && after?.showJump === true
  })())
  check('keyboard lift making a fitting chat overflow: offset stays 0, still pinned', (() => {
    // Before the lift the transcript fits the window (cannot scroll). The IME
    // shrinks viewH below contentH — the inverted list keeps offset 0, so the
    // newest message stays flush above the keys.
    const before = evaluateStick({ y: 0, contentH: 500, viewH: 800 })
    const after = evaluateStick({ y: 0, contentH: 500, viewH: 400 })
    return before?.stick === true && after?.stick === true
  })())

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-chat-scroll crashed:', err)
  process.exit(1)
})
