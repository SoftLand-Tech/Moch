// Unit tests for the voice recording waveform's pure logic (no gateway, no
// RN): dBFS→level mapping, the rolling level window, bar layout, and the
// recording timer format.
//
// voice.ts cannot load in plain node (expo/react-native at import time), so
// everything tested here lives in src/lib/voiceLevels.ts.
type V = typeof import('../src/lib/voiceLevels')

let v: V

let pass = 0
let fail = 0

function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++
    console.log(`  ok ${name}`)
  } else {
    fail++
    console.error(`FAIL ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

async function main() {
  v = await import('../src/lib/voiceLevels')

  // ── 1. levelToUnit: dBFS → 0..1 ─────────────────────────────────────────
  {
    check('silence and missing metering map to 0', v.levelToUnit(-160) === 0 && v.levelToUnit(undefined) === 0 && v.levelToUnit(NaN) === 0)
    check('full scale maps to 1 and clamps over', v.levelToUnit(0) === 1 && v.levelToUnit(10) === 1)
    check('voice floor maps to 0', v.levelToUnit(-45) === 0 && v.levelToUnit(-46) === 0)
    // Mid-speech (−22.5 dB) is half-linear; gamma 1.25 dims it below half.
    const mid = v.levelToUnit(-22.5)
    check('mid-level sits between floor and full, gamma-compressed', mid > 0.15 && mid < 0.5, `mid=${mid}`)
    check('monotonic across the voice band', v.levelToUnit(-40) < v.levelToUnit(-30) && v.levelToUnit(-30) < v.levelToUnit(-20) && v.levelToUnit(-20) < v.levelToUnit(-10))
  }

  // ── 2. pushLevel: rolling window ─────────────────────────────────────────
  {
    check('appends and keeps newest under the cap', (() => {
      let w: number[] = []
      for (let i = 1; i <= 5; i++) w = v.pushLevel(w, -10 * (6 - i) - 20, 3) // -50..-10, rising
      return w.length === 3 && w[2] > w[0] // later (louder) readings shifted right
    })())
    check('silence reading lands as 0, not NaN', v.pushLevel([], undefined, 4)[0] === 0 && v.pushLevel([], -160, 4)[0] === 0)
    check('window never exceeds max', (() => {
      let w: number[] = []
      for (let i = 0; i < 50; i++) w = v.pushLevel(w, -20, 26)
      return w.length === 26
    })())
    check('input array is not mutated', (() => {
      const w = [0.5]
      v.pushLevel(w, -10, 4)
      return w.length === 1
    })())
  }

  // ── 3. barsFromLevels: layout ────────────────────────────────────────────
  {
    check('pads left with zero-height bars until the window fills', (() => {
      const bars = v.barsFromLevels([0.5], 4)
      return bars.length === 4 && bars[0] === 0 && bars[3] > bars[0]
    })())
    check('newest level lands at the right edge', (() => {
      const bars = v.barsFromLevels([0, 1], 2)
      return bars[0] < bars[1]
    })())
    check('window longer than barCount keeps only the newest tail', (() => {
      const levels = [0, 0, 0, 0, 1]
      const bars = v.barsFromLevels(levels, 2)
      return bars[1] > 0.9
    })())
    check('zero levels still hold a visible floor', (() => {
      const bars = v.barsFromLevels([0, 0, 0], 3)
      return bars.every((b) => b > 0 && b < 0.2)
    })())
  }

  // ── 4. formatRecSecs: timer text ─────────────────────────────────────────
  {
    check('m:ss formatting and guards', v.formatRecSecs(0) === '0:00' && v.formatRecSecs(59) === '0:59' && v.formatRecSecs(60) === '1:00' && v.formatRecSecs(75) === '1:15' && v.formatRecSecs(601) === '10:01' && v.formatRecSecs(-2) === '0:00')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

// Module scope (this `export` keeps the helpers from colliding with the
// other scripts/*.ts files, which tsconfig.scripts.json treats as one scope).
export {}

main().catch((err) => {
  console.error('test-voice crashed:', err)
  process.exit(1)
})
