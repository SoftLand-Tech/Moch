// Unit tests for the drawer's IME/drag arbitration (src/lib/sidebarKeyboard.ts).
// Pure: no react-native, no stores — run directly with
//   npx tsx scripts/test-sidebar-keyboard.ts
//
// `export {}` keeps this script a module so its top-level names never collide
// with the other script-style suites (same reason as test-browser-relay.ts).
export {}
import {
  shouldClaimPanelClose,
  shouldDismissImeOnPanelDrag,
  type PanelDragState,
  type PanelDragVector,
} from '../src/lib/sidebarKeyboard'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const state = (over: Partial<PanelDragState> = {}): PanelDragState => ({
  open: true,
  keyboardVisible: false,
  searchFocused: false,
  dialogActive: false,
  ...over,
})

const drag = (over: Partial<PanelDragVector> = {}): PanelDragVector => ({
  dx: -48,
  dy: 6,
  rtl: false,
  ...over,
})

const expect = (
  name: string,
  actual: { dismiss: boolean; close: boolean },
  expected: { dismiss: boolean; close: boolean },
) => {
  const ok = actual.dismiss === expected.dismiss && actual.close === expected.close
  check(name, ok, ok ? '' : `got dismiss=${actual.dismiss} close=${actual.close}`)
}

/** Run both helpers for one scenario. */
const decide = (s: PanelDragState, d: PanelDragVector) => ({
  dismiss: shouldDismissImeOnPanelDrag(s, d),
  close: shouldClaimPanelClose(s, d),
})

// ── Normal close (no IME) keeps today's behaviour ──────────────────────────
expect('LTR horizontal close drag is claimed when no IME is up', decide(state(), drag()), {
  dismiss: false,
  close: true,
})
expect(
  'RTL mirrored close drag (dx > 0) is claimed',
  decide(state(), drag({ dx: 48, rtl: true })),
  { dismiss: false, close: true },
)
expect(
  'RTL opposite drag does not close',
  decide(state(), drag({ dx: -48, rtl: true })),
  { dismiss: false, close: false },
)
expect(
  'LTR opposite drag does not close',
  decide(state(), drag({ dx: 48 })),
  { dismiss: false, close: false },
)
expect(
  'vertical-dominant drag never claims (list scroll wins)',
  decide(state(), drag({ dx: -18, dy: 40 })),
  { dismiss: false, close: false },
)
expect(
  'under-threshold travel never claims',
  decide(state(), drag({ dx: -6, dy: 1 })),
  { dismiss: false, close: false },
)
expect('closed drawer never claims', decide(state({ open: false }), drag()), {
  dismiss: false,
  close: false,
})

// ── IME up: one-gesture dismiss, never close ──────────────────────────────
expect('IME open + LTR drag dismisses the IME and does not close', decide(state({ keyboardVisible: true }), drag()), {
  dismiss: true,
  close: false,
})
expect(
  'IME open + RTL mirrored drag dismisses the IME',
  decide(state({ keyboardVisible: true }), drag({ dx: 48, rtl: true })),
  { dismiss: true, close: false },
)
expect(
  'IME open + opposite drag claims nothing',
  decide(state({ keyboardVisible: true }), drag({ dx: 48 })),
  { dismiss: false, close: false },
)

// ── Search-focused drags are native text selection, never panel gestures ──
expect(
  'search focused + IME open: no drag claim at all',
  decide(state({ keyboardVisible: true, searchFocused: true }), drag()),
  { dismiss: false, close: false },
)
expect(
  'search focused without IME still never closes the drawer',
  decide(state({ searchFocused: true }), drag()),
  { dismiss: false, close: false },
)

// ── Dialogs and menus keep their drags ────────────────────────────────────
expect(
  'dialog active + IME open: no drag claim',
  decide(state({ keyboardVisible: true, dialogActive: true }), drag()),
  { dismiss: false, close: false },
)
expect(
  'dialog active without IME: panel close stays blocked',
  decide(state({ dialogActive: true }), drag()),
  { dismiss: false, close: false },
)

// ── Shared tuning (Sidebar passes its EDGE_CLAIM / DOMINANCE) ──────────────
expect(
  'custom edge claim below threshold is rejected',
  decide(state(), drag({ dx: -15, edgeClaim: 20 })),
  { dismiss: false, close: false },
)
expect(
  'custom edge claim above threshold is claimed',
  decide(state(), drag({ dx: -25, edgeClaim: 20 })),
  { dismiss: false, close: true },
)
expect(
  'custom dominance rejects a mixed drag',
  decide(state(), drag({ dx: -30, dy: 20, dominance: 2 })),
  { dismiss: false, close: false },
)

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
if (fail) process.exit(1)
